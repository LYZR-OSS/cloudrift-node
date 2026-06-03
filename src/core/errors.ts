/**
 * Unified CloudRift error hierarchy.
 *
 * Every provider error is translated at the adapter boundary into one of these
 * classes (with the original SDK error attached via `cause`). Nothing above the
 * adapter layer should ever observe a raw SDK error type — the one documented
 * exception is the document module, whose operation errors stay native (only
 * connect-time failures become `DocumentConnectionError`).
 *
 * Mirrors ARCHITECTURE.md section 4.1 (17 classes). Each class sets `this.name`
 * to its own class name so error logs and `instanceof`-free checks stay legible.
 */

/** Root of the entire CloudRift error tree. */
export class CloudRiftError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CloudRiftError";
  }
}

/* ---- storage ---- */

export class StorageError extends CloudRiftError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class ObjectNotFoundError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ObjectNotFoundError";
  }
}

export class StoragePermissionError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoragePermissionError";
  }
}

/* ---- messaging ---- */

export class MessagingError extends CloudRiftError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MessagingError";
  }
}

export class QueueNotFoundError extends MessagingError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QueueNotFoundError";
  }
}

export class MessageSendError extends MessagingError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MessageSendError";
  }
}

/* ---- document ---- */

export class DocumentConnectionError extends CloudRiftError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentConnectionError";
  }
}

/* ---- cache ---- */

export class CacheError extends CloudRiftError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CacheError";
  }
}

export class CacheConnectionError extends CacheError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CacheConnectionError";
  }
}

export class CacheKeyNotFoundError extends CacheError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CacheKeyNotFoundError";
  }
}

/* ---- secrets ---- */

export class SecretError extends CloudRiftError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretError";
  }
}

export class SecretNotFoundError extends SecretError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretNotFoundError";
  }
}

export class SecretPermissionError extends SecretError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretPermissionError";
  }
}

/* ---- pubsub ---- */

export class PubSubError extends CloudRiftError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PubSubError";
  }
}

export class TopicNotFoundError extends PubSubError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TopicNotFoundError";
  }
}

export class PublishError extends PubSubError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PublishError";
  }
}
