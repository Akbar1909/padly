import type { ActionFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import {
  clientIp,
  isOwner,
  readTryForm,
  refundTry,
  runTry,
  takeTry,
  takeTrySlot,
  TRY_MAX_BYTES,
  TryError,
} from "../lib/try.server";

/** The try-it form lives on the landing page. */
export const loader = () => redirect("/#try");

/** Multipart overhead on top of the photo itself (boundaries and the other fields). */
const FORM_OVERHEAD = 64 * 1024;

const fail = (error: string, status: number) => data({ error }, { status });

export const action = async ({ request }: ActionFunctionArgs) => {
  // Refuse unsized or oversized uploads before reading any of the body.
  // Browsers always send Content-Length for a form upload.
  const length = request.headers.get("content-length");
  if (length === null) {
    return fail("We couldn't read that upload. Please try again.", 411);
  }
  const size = Number(length);
  if (!Number.isInteger(size) || size < 0) {
    return fail("We couldn't read that upload. Please try again.", 400);
  }
  if (size > TRY_MAX_BYTES + FORM_OVERHEAD) {
    return fail("That photo is over 12 MB. Try a smaller one.", 413);
  }

  // The image service is shared with merchants' jobs, so one try at a time
  // across all visitors (the owner included). Checked before the body is read,
  // and a busy answer uses none of the visitor's tries.
  const release = await takeTrySlot();
  if (!release) {
    return fail(
      "We're cleaning another photo right now. Please try again in a minute.",
      429,
    );
  }

  const ip = clientIp(request);
  const owner = isOwner(request);
  let taken = false;
  try {
    let remaining: number | null = null; // null = unlimited (owner)
    if (!owner) {
      remaining = await takeTry(ip);
      taken = true;
    }
    // Bounded in time: the slot is held while the body arrives.
    const form = await readTryForm(request);
    const photo = form.get("photo");
    if (!(photo instanceof File))
      throw new TryError("Choose a photo to upload.");
    const result = await runTry(photo, {
      aspect: form.get("aspect") === "4:5" ? "4:5" : "1:1",
      keepBackground: form.get("background") === "keep",
    });
    return { result, remaining };
  } catch (error) {
    // Bad input (wrong type, too many pixels…) still uses the try: rejecting it
    // cost little. Our own failures give it back, at most twice a day.
    const ours = !(error instanceof TryError) || error.status >= 500;
    if (taken && ours) await refundTry(ip);
    if (error instanceof TryError) return fail(error.message, error.status);
    console.error("try failed", error);
    return fail("Something went wrong on our side. Please try again.", 500);
  } finally {
    await release();
  }
};
