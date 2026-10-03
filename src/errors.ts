/** 统一错误码与校验错误。 */

export const ErrorCode = {
  INVALID_IDENTIFIER: "INVALID_IDENTIFIER",
  NAME_TOO_LONG: "NAME_TOO_LONG",
  TOO_MANY_CLASSES: "TOO_MANY_CLASSES",
  DUPLICATE_CLASS: "DUPLICATE_CLASS",
  DUPLICATE_PARENT: "DUPLICATE_PARENT",
  SELF_INHERITANCE: "SELF_INHERITANCE",
  MISSING_PARENT: "MISSING_PARENT",
  INHERITANCE_CYCLE: "INHERITANCE_CYCLE",
  C3_CONFLICT: "C3_CONFLICT",
  CLASS_NOT_FOUND: "CLASS_NOT_FOUND",
  VERSION_NOT_FOUND: "VERSION_NOT_FOUND",
  EMPTY_BATCH: "EMPTY_BATCH",
  INVALID_BODY: "INVALID_BODY",
  NOTHING_TO_IMPORT: "NOTHING_TO_IMPORT",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface FieldError {
  code: ErrorCodeType;
  message: string;
  /** 出错类名（如适用）。 */
  className?: string;
  /** 输入行号（如适用）。 */
  line?: number;
  /** 环路径（仅 INHERITANCE_CYCLE）。 */
  cycle?: string[];
}

/** 声明批量校验错误：批量导入遇到此错误时整体不落库。 */
export class ValidationError extends Error {
  readonly errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(errors.map((e) => e.message).join("; "));
    this.name = "ValidationError";
    this.errors = errors;
  }
}

/** 单个资源不存在等 404 类错误。 */
export class ApiError extends Error {
  readonly code: ErrorCodeType;
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(
    code: ErrorCodeType,
    message: string,
    status = 400,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}
