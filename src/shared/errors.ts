/**
 * Domain-level errors. Routes map these to HTTP responses in one place;
 * repositories and services throw them without knowing about HTTP.
 */
export class NotFoundError extends Error {
  public constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} '${id}' was not found`);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  public readonly statusCode = 403;
  public constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class InvalidStateTransitionError extends Error {
  public constructor(
    public readonly entity: string,
    public readonly id: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid ${entity} transition for '${id}': ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}
