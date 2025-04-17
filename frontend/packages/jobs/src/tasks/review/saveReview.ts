import { logger, task } from '@trigger.dev/sdk/v3'
import { getInstallationIdFromRepositoryId } from '../../functions/getInstallationIdFromRepositoryId'
import { createClient } from '../../libs/supabase'
import {
  generateDocsSuggestionTask,
  generateSchemaOverrideSuggestionTask,
} from '../../trigger/jobs'
import type { ReviewResponse } from './generateReview'
import { postCommentTask } from './postComment'

export const processSaveReview = async (
  payload: ReviewResponse,
): Promise<{ success: boolean; overallReviewId: string }> => {
  try {
    const supabase = createClient()
    const { data: pullRequest, error: pullRequestError } = await supabase
      .from('pull_requests')
      .select('*')
      .eq('id', payload.pullRequestId)
      .single()

    if (pullRequestError || !pullRequest) {
      throw new Error(
        `PullRequest not found: ${JSON.stringify(pullRequestError)}`,
      )
    }

    const now = new Date().toISOString()

    const { data: overallReview, error: overallReviewError } = await supabase
      .from('overall_reviews')
      .insert({
        project_id: payload.projectId,
        pull_request_id: pullRequest.id,
        review_comment: payload.review.bodyMarkdown,
        branch_name: payload.branchName,
        trace_id: payload.traceId,
        updated_at: now,
      })
      .select()
      .single()

    if (overallReviewError || !overallReview) {
      throw new Error(
        `Failed to create overall review: ${JSON.stringify(overallReviewError)}`,
      )
    }

    const reviewFeedbacks = payload.review.feedbacks.map((feedback) => ({
      overall_review_id: overallReview.id,
      category: mapCategoryEnum(feedback.kind),
      severity: mapSeverityEnum(feedback.severity),
      description: feedback.description,
      suggestion: feedback.suggestion,
      updated_at: now,
    }))

    const { data: insertedFeedbacks, error: reviewFeedbacksError } =
      await supabase
        .from('review_feedbacks')
        .insert(reviewFeedbacks)
        .select('id')

    if (reviewFeedbacksError || !insertedFeedbacks) {
      throw new Error(
        `Failed to create review feedbacks: ${JSON.stringify(reviewFeedbacksError)}`,
      )
    }

    const suggestionSnippet = payload.review.feedbacks
      .map((feedback, index) => {
        const reviewFeedback = insertedFeedbacks[index]
        return reviewFeedback
          ? {
              feedback,
              review_feedback_id: reviewFeedback.id,
            }
          : null
      })
      .filter(
        (
          item,
        ): item is {
          feedback: (typeof payload.review.feedbacks)[0]
          review_feedback_id: string
        } => item !== null && item.feedback.severity !== 'POSITIVE',
      )
      .flatMap(({ feedback, review_feedback_id }) =>
        feedback.suggestionSnippets.map((snippet) => ({
          ...snippet,
          review_feedback_id,
          updated_at: now,
        })),
      ) as Array<{
      filename: string
      snippet: string
      review_feedback_id: string
      updated_at: string
    }>

    const { data: insertedSuggestionSnippets, error: suggestionSnippetError } =
      await supabase
        .from('review_suggestion_snippets')
        .insert(suggestionSnippet)
        .select('id')

    if (suggestionSnippetError || !insertedSuggestionSnippets) {
      throw new Error(
        `Failed to create suggestion snippet: ${JSON.stringify(suggestionSnippetError)}`,
      )
    }

    return {
      success: true,
      overallReviewId: overallReview.id,
    }
  } catch (error) {
    console.error('Error saving review:', error)
    throw error
  }
}

const mapCategoryEnum = (
  category: string,
):
  | 'MIGRATION_SAFETY'
  | 'DATA_INTEGRITY'
  | 'PERFORMANCE_IMPACT'
  | 'PROJECT_RULES_CONSISTENCY'
  | 'SECURITY_OR_SCALABILITY' => {
  const mapping: Record<
    string,
    | 'MIGRATION_SAFETY'
    | 'DATA_INTEGRITY'
    | 'PERFORMANCE_IMPACT'
    | 'PROJECT_RULES_CONSISTENCY'
    | 'SECURITY_OR_SCALABILITY'
  > = {
    'Migration Safety': 'MIGRATION_SAFETY',
    'Data Integrity': 'DATA_INTEGRITY',
    'Performance Impact': 'PERFORMANCE_IMPACT',
    'Project Rules Consistency': 'PROJECT_RULES_CONSISTENCY',
    'Security or Scalability': 'SECURITY_OR_SCALABILITY',
    Unknown: 'MIGRATION_SAFETY', // Default to MIGRATION_SAFETY for unknown categories
  }
  const result = mapping[category]
  if (!result) {
    console.warn(
      `Unknown category: ${category}, defaulting to MIGRATION_SAFETY`,
    )
    return 'MIGRATION_SAFETY'
  }
  return result
}

const mapSeverityEnum = (
  severity:
    | 'POSITIVE'
    | 'CRITICAL'
    | 'WARNING'
    | 'QUESTION'
    | 'HIGH'
    | 'MEDIUM'
    | 'LOW',
): 'POSITIVE' | 'CRITICAL' | 'WARNING' | 'QUESTION' => {
  const mapping: Record<
    string,
    'POSITIVE' | 'CRITICAL' | 'WARNING' | 'QUESTION'
  > = {
    POSITIVE: 'POSITIVE',
    CRITICAL: 'CRITICAL',
    WARNING: 'WARNING',
    QUESTION: 'QUESTION',
    HIGH: 'CRITICAL',
    MEDIUM: 'WARNING',
    LOW: 'QUESTION',
  }
  return mapping[severity] || 'WARNING'
}

export const saveReviewTask = task({
  id: 'save-review',
  run: async (payload: ReviewResponse) => {
    logger.log('Executing review save task:', { payload })
    try {
      const { overallReviewId } = await processSaveReview(payload)

      logger.log('Creating knowledge suggestions for docs')

      const installationId = await getInstallationIdFromRepositoryId(
        payload.repositoryId,
      )

      await postCommentTask.trigger({
        reviewComment: payload.review.bodyMarkdown,
        projectId: payload.projectId,
        pullRequestId: payload.pullRequestId,
        repositoryId: payload.repositoryId,
        branchName: payload.branchName,
        traceId: payload.traceId,
      })

      await generateDocsSuggestionTask.trigger({
        review: payload.review,
        projectId: payload.projectId,
        pullRequestNumber: payload.pullRequestNumber,
        owner: payload.owner,
        name: payload.name,
        installationId,
        type: 'DOCS',
        branchName: payload.branchName,
        overallReviewId,
      })

      await generateSchemaOverrideSuggestionTask.trigger({
        overallReviewId,
      })

      return { success: true }
    } catch (error) {
      console.error('Error in review process:', error)

      if (error instanceof Error) {
        return {
          success: false,
          error: {
            message: error.message,
            type: error.constructor.name,
          },
        }
      }

      return {
        success: false,
        error: {
          message: 'An unexpected error occurred',
          type: 'UnknownError',
        },
      }
    }
  },
})
