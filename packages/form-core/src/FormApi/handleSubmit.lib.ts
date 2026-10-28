import { batch } from '@tanstack/store'
import {
  isErrorResult,
  isValidationErrorMap,
  parseValidationResult,
} from '../validation'
import { parseStandardSchemaIssues } from '../standardSchema.lib'
import { createErrorMap } from '../validation.public'
import type { InternalFormApi } from './FormApi.lib'
import type {
  FormValidateResult,
  FormValidationError,
  ValidationErrorInput,
  ValidationErrorMap,
} from '../validation.public'
import type {
  CreateSubmitErrorMapFn,
  CreateValidationErrorFn,
  FormSubmitCause,
  FormSubmitResult,
  OnSubmitError,
  ParseSubmitIssuesFn,
} from './FormApi.public'

export const SUBMIT_ERROR = Symbol('SUBMIT_ERROR')

function isSubmitError<TFormData>(
  value: unknown,
): value is OnSubmitError<FormValidationError<TFormData>> {
  return typeof value === 'object' && value !== null && SUBMIT_ERROR in value
}

const createValidationError: CreateValidationErrorFn<any> = <
  TError extends FormValidationError<any>,
>(
  error: TError,
): OnSubmitError<TError> => {
  return createSubmitError(error)
}

function createSubmitError<TError extends FormValidationError<any>>(
  error: TError,
): OnSubmitError<TError> {
  return { [SUBMIT_ERROR]: error }
}

function createSubmitErrorMap<TFormData>(
  initial?: Partial<ValidationErrorMap<TFormData>>,
): ReturnType<CreateSubmitErrorMapFn<TFormData>> {
  const map = createErrorMap(initial)
  Object.defineProperty(map, SUBMIT_ERROR, { value: map })
  return map as ReturnType<CreateSubmitErrorMapFn<TFormData>>
}

function createParseIssues<TFormData>(
  value: TFormData,
): ParseSubmitIssuesFn<TFormData> {
  return (issues) => {
    return createSubmitError(parseStandardSchemaIssues(issues, value, 'form'))
  }
}

export async function runSubmissionProcess<TFormData>(
  form: InternalFormApi<TFormData, any, any>,
): Promise<FormSubmitResult<TFormData>> {
  const submitResetVersion = form._atoms.resetVersion.get()
  const hasResettedFormDuringSubmit = () =>
    form._atoms.resetVersion.get() !== submitResetVersion

  batch(() => {
    form._atoms.meta.submissionAttempts.set((prev) => prev + 1)
    form._atoms.meta.isSubmitting.set(true)
  })

  const submissionData = {
    cause: null as FormSubmitCause | null,
    // Wrapped so that `throw undefined` and `throw null` still count as thrown.
    exception: null as { cause: FormSubmitCause; error: unknown } | null,
    submitError:
      null satisfies FormValidateResult<TFormData> as FormValidateResult<TFormData>,
  }

  const hasFailed = () => submissionData.cause !== null

  const recordFailure = (cause: FormSubmitCause) => {
    submissionData.cause ??= cause
  }

  const recordException = (cause: FormSubmitCause, error: unknown) => {
    recordFailure(cause)
    submissionData.exception ??= { cause, error }
  }

  const fields = form._fieldRootNode._touchAllFieldsAndCollectSubmitValidators()

  const fieldValidatorResults = await Promise.all(
    fields.map((field) =>
      field._runFieldValidation('submit', { onResult: false }),
    ),
  )

  if (hasResettedFormDuringSubmit()) {
    return { errors: [], cause: null }
  }

  const fieldResults: Array<ValidationErrorInput> = []

  batch(() => {
    for (let i = 0; i < fieldValidatorResults.length; i++) {
      const field = fields[i]!
      const pipelineResult = fieldValidatorResults[i]!

      if (pipelineResult.thrownError !== null) {
        recordException('field_validation', pipelineResult.thrownError)
      }

      for (const result of pipelineResult.results) {
        if (isErrorResult(result.result)) {
          recordFailure('field_validation')
          fieldResults.push(result.result)
        }
        field._processValidationResult(result, 'submit')
      }
    }
  })

  // TODO maybe some users don't want form validation to run if field validation failed.
  // Configurable option with opt-out wouldn't hurt.
  // Also keep in mind this would apply to handleChange too.
  const formPipelineResult = await form._runFormValidation('submit', {
    hasFailedBefore: hasFailed(),
  })

  if (hasResettedFormDuringSubmit()) {
    return { errors: [], cause: null }
  }

  if (formPipelineResult.thrownError !== null) {
    recordException('form_validation', formPipelineResult.thrownError)
  } else if (formPipelineResult.hasErrors) {
    recordFailure('form_validation')
  }

  const errorResults = formPipelineResult.results
    .map(({ result }) => result)
    .filter(isErrorResult)
    .concat(fieldResults)

  const cleanup = () => {
    if (hasResettedFormDuringSubmit()) {
      return
    }

    batch(() => {
      form._atoms.meta.isSubmitting.set(false)
      form._atoms.meta.isSubmitSuccessful.set(!hasFailed())
    })
  }

  const finishInvalidSubmission = async (
    value: TFormData,
  ): Promise<FormSubmitResult<TFormData>> => {
    // Decided up front so that `onSubmitInvalid` cannot change the outcome.
    const { exception } = submissionData
    const cause = exception?.cause ?? submissionData.cause!

    try {
      await form._options.onSubmitInvalid?.({
        value,
        formApi: form as never,
        cause,
      })
    } finally {
      cleanup()
    }

    if (exception) {
      throw exception.error
    }

    if (hasResettedFormDuringSubmit()) {
      return { errors: [], cause: null }
    }

    // TODO ew. Resolve this differently, this is really bad.
    const errors = errorResults.flatMap<FormValidationError<TFormData>>(
      (error) => {
        const { self, subfields } = parseValidationResult(error)
        if (isValidationErrorMap(error)) {
          return [
            { ...error, form: self ?? undefined, fields: subfields ?? {} },
          ]
        }
        return self ?? []
      },
    )

    return { errors, cause }
  }

  if (hasFailed()) {
    return finishInvalidSubmission(form.state.values)
  }

  const validatorOutputs = form._validatorInstances?.map((v) => v.output) ?? []
  const value = form.state.values

  try {
    const maybeError = await form._options.onSubmit?.({
      formApi: form as never,
      validatorOutputs,
      value,
      createValidationError,
      createErrorMap: createSubmitErrorMap,
      parseIssues: createParseIssues(value),
    })

    if (hasResettedFormDuringSubmit()) {
      return { errors: [], cause: null }
    }

    // Store onSubmit errors separately from installed validator instances.
    if (isSubmitError<TFormData>(maybeError)) {
      const error = maybeError[SUBMIT_ERROR]
      form._processSubmitValidationResult(error, 'submit')
      submissionData.submitError = error
    } else {
      form._processSubmitValidationResult(null, 'submit')
    }
  } catch (e) {
    if (hasResettedFormDuringSubmit()) {
      return { errors: [], cause: null }
    }

    recordException('on_submit', e)
  }

  batch(() => {
    if (isErrorResult(submissionData.submitError)) {
      recordFailure('on_submit')
      errorResults.push(submissionData.submitError)
    }
  })

  if (hasFailed()) {
    return finishInvalidSubmission(value)
  }

  cleanup()
  return { errors: [], cause: null }
}
