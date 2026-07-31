export {
  type AbandonedUpload,
  type CompletedPart,
  type CreateMultipartUploadRequest,
  type ListAbandonedUploadsRequest,
  type MultipartUploadHandle,
  type ObjectStorageAdapter,
  ObjectStorageError,
  type SignedPartInstruction,
  type StoredObjectMetadata,
} from "./storage/contract.js";
export {
  createFakeObjectStorage,
  type FakeObjectStorage,
  type FakeObjectStorageDependencies,
} from "./storage/fake-adapter.js";
export {
  createSourceVideoObjectKey,
  isSourceVideoObjectKeyFor,
  type SourceVideoKeyParts,
} from "./storage/object-key.js";
export {
  createS3ObjectStorageAdapter,
  type S3ObjectStorageDependencies,
} from "./storage/s3-adapter.js";
