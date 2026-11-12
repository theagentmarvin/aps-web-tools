/** Spanish/English user messages for passkey errors (keys passkey.errors.*). */
import type { TFunction, TKey } from "~/i18n";
import { PasskeyError } from "./webauthn";

export function passkeyMessage(t: TFunction, err: unknown): string {
  if (err instanceof PasskeyError) return t(`passkey.errors.${err.kind}` as TKey, { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
