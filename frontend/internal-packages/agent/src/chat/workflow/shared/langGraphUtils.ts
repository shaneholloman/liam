import { Annotation } from '@langchain/langgraph'
import type { Schema } from '@liam-hq/db-structure'
import type { Repositories } from '../../../repositories'
import { WORKFLOW_ERROR_MESSAGES } from '../constants/progressMessages'
import { answerGenerationNode } from '../nodes'

/**
 * ChatState definition for LangGraph
 */
export interface ChatState {
  userInput: string
  generatedAnswer?: string | undefined
  finalResponse?: string | undefined
  history: string[]
  schemaData: Schema
  projectId?: string | undefined
  buildingSchemaId: string
  latestVersionNumber?: number | undefined
  organizationId?: string | undefined
  userId: string
  designSessionId: string
  error?: string | undefined

  // Repository dependencies for data access
  repositories: Repositories
}

export const DEFAULT_RECURSION_LIMIT = 10

/**
 * Create LangGraph-compatible annotations (shared)
 */
export const createAnnotations = () => {
  return Annotation.Root({
    userInput: Annotation<string>,
    generatedAnswer: Annotation<string | undefined>,
    finalResponse: Annotation<string | undefined>,
    history: Annotation<string[]>,
    schemaData: Annotation<Schema>,
    projectId: Annotation<string | undefined>,
    buildingSchemaId: Annotation<string>,
    latestVersionNumber: Annotation<number | undefined>,
    organizationId: Annotation<string | undefined>,
    userId: Annotation<string>,
    designSessionId: Annotation<string>,
    error: Annotation<string | undefined>,

    // Repository dependencies for data access
    repositories: Annotation<Repositories>,
  })
}

/**
 * Wrap answerGenerationNode for LangGraph (shared)
 */
export const generateAnswer = async (
  state: ChatState,
): Promise<Partial<ChatState>> => {
  try {
    const result = await answerGenerationNode(state)
    return {
      generatedAnswer: result.generatedAnswer,
      error: result.error,
    }
  } catch (e) {
    return {
      error:
        e instanceof Error
          ? e.message
          : WORKFLOW_ERROR_MESSAGES.ANSWER_GENERATION_FAILED,
    }
  }
}
