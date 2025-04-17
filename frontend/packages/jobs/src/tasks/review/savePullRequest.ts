import {
  getFileContent,
  getPullRequestDetails,
  getPullRequestFiles,
} from '@liam-hq/github'
import { logger, task } from '@trigger.dev/sdk/v3'
import { type SupabaseClient, createClient } from '../../libs/supabase'
import { generateReviewTask } from './generateReview'

type SavePullRequestPayload = {
  prNumber: number
  projectId: string
}

export type SavePullRequestResult = {
  success: boolean
  prId: string
  repositoryId: string
  schemaFile: {
    filename: string
    content: string
  }
  fileChanges: Array<{
    filename: string
    status:
      | 'added'
      | 'modified'
      | 'deleted'
      | 'removed'
      | 'renamed'
      | 'copied'
      | 'changed'
      | 'unchanged'
    changes: number
    patch: string
  }>
  branchName: string
}

type Repository = {
  id: string
  installation_id: number
  owner: string
  name: string
}

type FileChange = {
  filename: string
  status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'removed'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged'
  changes: number
  patch?: string
}

type SchemaFile = {
  filename: string
  content: string
}

async function getRepositoryFromProjectId(
  supabase: SupabaseClient,
  projectId: string,
): Promise<Repository> {
  const { data: projectMapping, error: mappingError } = await supabase
    .from('project_repository_mappings')
    .select(`
      *,
      repositories(*)
    `)
    .eq('project_id', projectId)
    .limit(1)
    .maybeSingle()

  if (mappingError || !projectMapping) {
    throw new Error(`No repository found for project ID: ${projectId}`)
  }

  return projectMapping.repositories
}

async function getSchemaPathForProject(
  supabase: SupabaseClient,
  projectId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('github_schema_file_paths')
    .select('path')
    .eq('project_id', projectId)
    .single()

  if (error) {
    throw new Error(
      `No schema path found for project ${projectId}: ${JSON.stringify(error)}`,
    )
  }

  return data.path
}

async function fetchSchemaFileContent(
  repository: Repository,
  schemaPath: string,
  branchRef: string,
): Promise<SchemaFile> {
  try {
    const { content } = await getFileContent(
      `${repository.owner}/${repository.name}`,
      schemaPath,
      branchRef,
      Number(repository.installation_id),
    )

    if (!content) {
      throw new Error(`No content found for schema file: ${schemaPath}`)
    }

    return {
      filename: schemaPath,
      content,
    }
  } catch (error) {
    console.error(`Error fetching content for ${schemaPath}:`, error)
    throw new Error(
      `Failed to fetch schema file content: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function formatFileChangesData(
  fileChanges: FileChange[],
): SavePullRequestResult['fileChanges'] {
  return fileChanges.map((file) => ({
    filename: file.filename,
    status: file.status,
    changes: file.changes,
    patch: file?.patch || '',
  }))
}

async function getOrCreatePullRequestRecord(
  supabase: SupabaseClient,
  repositoryId: string,
  pullNumber: number,
): Promise<{ id: string }> {
  const { data: existingPR } = await supabase
    .from('pull_requests')
    .select('id')
    .eq('repository_id', repositoryId)
    .eq('pull_number', pullNumber)
    .maybeSingle()

  if (existingPR) {
    return existingPR
  }

  const now = new Date().toISOString()
  const { data: newPR, error: createPRError } = await supabase
    .from('pull_requests')
    .insert({
      repository_id: repositoryId,
      pull_number: pullNumber,
      updated_at: now,
    })
    .select()
    .single()

  if (createPRError || !newPR) {
    throw new Error(
      `Failed to create PR record: ${JSON.stringify(createPRError)}`,
    )
  }

  return newPR
}

async function createOrUpdateMigrationRecord(
  supabase: SupabaseClient,
  pullRequestId: string,
  title: string,
): Promise<void> {
  const { data: existingMigration } = await supabase
    .from('migrations')
    .select('id')
    .eq('pull_request_id', pullRequestId)
    .maybeSingle()

  const now = new Date().toISOString()

  if (existingMigration) {
    const { error: updateMigrationError } = await supabase
      .from('migrations')
      .update({
        title,
        updated_at: now,
      })
      .eq('id', existingMigration.id)

    if (updateMigrationError) {
      throw new Error(
        `Failed to update migration: ${JSON.stringify(updateMigrationError)}`,
      )
    }
  } else {
    const { error: createMigrationError } = await supabase
      .from('migrations')
      .insert({
        pull_request_id: pullRequestId,
        title,
        updated_at: now,
      })

    if (createMigrationError) {
      throw new Error(
        `Failed to create migration: ${JSON.stringify(createMigrationError)}`,
      )
    }
  }
}

export async function processSavePullRequest(
  payload: SavePullRequestPayload,
): Promise<SavePullRequestResult> {
  const supabase = createClient()

  const repository = await getRepositoryFromProjectId(
    supabase,
    payload.projectId,
  )

  const fileChanges = await getPullRequestFiles(
    Number(repository.installation_id),
    repository.owner,
    repository.name,
    payload.prNumber,
  )

  const schemaPath = await getSchemaPathForProject(supabase, payload.projectId)

  const prDetails = await getPullRequestDetails(
    Number(repository.installation_id),
    repository.owner,
    repository.name,
    payload.prNumber,
  )

  const schemaFile = await fetchSchemaFileContent(
    repository,
    schemaPath,
    prDetails.head.ref,
  )

  const fileChangesData = formatFileChangesData(fileChanges)

  const prRecord = await getOrCreatePullRequestRecord(
    supabase,
    repository.id,
    payload.prNumber,
  )

  await createOrUpdateMigrationRecord(supabase, prRecord.id, prDetails.title)

  return {
    success: true,
    prId: prRecord.id,
    repositoryId: repository.id,
    schemaFile,
    fileChanges: fileChangesData,
    branchName: prDetails.head.ref,
  }
}

export const savePullRequestTask = task({
  id: 'save-pull-request',
  run: async (payload: SavePullRequestPayload) => {
    logger.log('Executing PR save task:', { payload })

    try {
      const result = await processSavePullRequest(payload)
      logger.info('Successfully saved PR to database:', { prId: result.prId })

      const supabase = createClient()
      const { data: repository, error: repositoryError } = await supabase
        .from('repositories')
        .select('*')
        .eq('id', result.repositoryId)
        .single()

      if (repositoryError || !repository) {
        throw new Error(
          `Repository not found: ${JSON.stringify(repositoryError)}`,
        )
      }

      await generateReviewTask.trigger({
        pullRequestId: result.prId,
        projectId: payload.projectId,
        repositoryId: repository.id,
        branchName: result.branchName,
        owner: repository.owner,
        name: repository.name,
        pullRequestNumber: payload.prNumber,
        schemaFile: result.schemaFile,
        fileChanges: result.fileChanges,
      })

      return result
    } catch (error) {
      logger.error('Error in savePullRequest task:', { error })
      throw error
    }
  },
})
