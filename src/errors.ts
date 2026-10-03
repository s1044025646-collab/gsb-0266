/** 统一错误码与错误类型。 */
export const ErrorCodes = {
  INVALID_NAME: "E_INVALID_NAME",
  INVALID_INPUT: "E_INVALID_INPUT",
  TOO_MANY_CLASSES: "E_TOO_MANY_CLASSES",
  DUPLICATE_CLASS: "E_DUPLICATE_CLASS",
  DUPLICATE_PARENT: "E_DUPLICATE_PARENT",
  MISSING_PARENT: "E_MISSING_PARENT",
  SELF_INHERITANCE: "E_SELF_INHERITANCE",
  CYCLE: "E_CYCLE",
  CONFLICT: "E_CONFLICT",
  CLASS_NOT_FOUND: "E_CLASS_NOT_FOUND",
  METHOD_NOT_FOUND: "E_METHOD_NOT_FOUND",
  VERSION_NOT_FOUND: "E_VERSION_NOT_FOUND",
} as const;

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly httpStatus: number = 400
  ) {
    super(message);
  }
}
