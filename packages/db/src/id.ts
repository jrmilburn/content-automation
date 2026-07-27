import { validate, version, v7 } from "uuid";

export function createId(): string {
  return v7();
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7;
}
