'use server'

import { createClient } from '@/libs/db/server'
import * as v from 'valibot'

const requestSchema = v.object({
  issueId: v.pipe(v.string()),
  resolutionComment: v.optional(v.nullable(v.string())),
})

export const resolveReviewFeedback = async (data: {
  issueId: string
  resolutionComment?: string | null
}) => {
  const parsedData = v.safeParse(requestSchema, data)

  if (!parsedData.success) {
    throw new Error(`Invalid data: ${JSON.stringify(parsedData.issues)}`)
  }

  const { issueId, resolutionComment } = parsedData.output

  try {
    const supabase = await createClient()

    const { data: updatedIssue, error } = await supabase
      .from('review_feedbacks')
      .update({
        resolved_at: new Date().toISOString(),
        resolution_comment: resolutionComment || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', issueId)
      .select()

    if (error) {
      throw new Error(`Failed to resolve issue: ${error.message}`)
    }

    return { success: true, data: updatedIssue }
  } catch (error) {
    console.error('Error resolving review issue:', error)
    throw error
  }
}
