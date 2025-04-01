import { prisma } from '@liam-hq/db'
import { getFileContent } from '@liam-hq/github'
import type { InferOutput } from 'valibot'
import { generateReview } from '../prompts/generateReview/generateReview'
import type { reviewSchema } from '../prompts/generateReview/reviewSchema'
import type { GenerateReviewPayload } from '../types'
import { langfuseLangchainHandler } from './langfuseLangchainHandler'

export const processGenerateReview = async (
  payload: GenerateReviewPayload,
): Promise<InferOutput<typeof reviewSchema>> => {
  try {
    // Get repository installationId
    const repository = await prisma.repository.findUnique({
      where: {
        id: payload.repositoryId,
      },
      select: {
        installationId: true,
      },
    })

    if (!repository) {
      throw new Error(`Repository with ID ${payload.repositoryId} not found`)
    }

    // Get review-enabled doc paths
    const docPaths = await prisma.gitHubDocFilePath.findMany({
      where: {
        projectId: payload.projectId,
        isReviewEnabled: true,
      },
    })

    // Fetch content for each doc path
    const docsContentArray = await Promise.all(
      docPaths.map(async (docPath) => {
        try {
          const fileData = await getFileContent(
            `${payload.owner}/${payload.name}`,
            docPath.path,
            payload.branchName,
            Number(repository.installationId),
          )

          if (!fileData.content) {
            console.warn(`No content found for ${docPath.path}`)
            return null
          }

          return `# ${docPath.path}\n\n${fileData.content}`
        } catch (error) {
          console.error(`Error fetching content for ${docPath.path}:`, error)
          return null
        }
      }),
    )

    // Filter out null values and join content
    const docsContent = docsContentArray.filter(Boolean).join('\n\n---\n\n')
    const callbacks = [langfuseLangchainHandler]
    const review = await generateReview(
      docsContent,
      payload.schemaFiles,
      payload.schemaChanges,
      callbacks,
    )
    return review
  } catch (error) {
    console.error('Error generating review:', error)
    throw error
  }
}
