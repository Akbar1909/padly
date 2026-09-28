import { MerchantError, PermanentError } from "../app/lib/errors";
import { GpuServiceError } from "../app/lib/gpu.server";
import { FileProcessingError } from "../app/lib/shopify/files.server";
import { ShopifyAuthError, ShopifyGraphqlError } from "../app/lib/shopify/graphql";

/**
 * What merchants see when an image or a job fails. The job page shows these as
 * they are; the technical error only goes to the logs (worker/index.ts logs
 * every failed attempt).
 */
export const MESSAGES = {
  busy: "Our image service was busy. Retry failed images in a few minutes.",
  shopify: "Shopify couldn't process this image. Try again later.",
  access: "Shopify didn't accept the app's access to your store. Open the app again, then retry failed images.",
  unreadable: "This image file couldn't be read. Replace it in Shopify with a JPG, PNG or WebP, then run a new job.",
  tooLarge: "This image is too large to process.",
  unknown: "Something went wrong with this image. Retry failed images in a few minutes.",
  read: "We couldn't read your products from Shopify. Please try again in a few minutes.",
  readAccess: "Shopify didn't accept the app's access to your store. Open the app again, then start a new job.",
  bulkFailed: "Shopify couldn't finish reading your products. Please try again in a few minutes.",
  readTooLong: "Reading products from Shopify took too long. Try a smaller selection.",
  crashed: "This image keeps stopping our image service. Retry it later or contact support.",
  notReady: "Shopify is still processing this image. Retry failed images in a few minutes.",
  timeout: "Processing this image took too long. Retry failed images later. If it keeps happening, replace it in Shopify with a smaller image and run a new job.",
  outOfMemory: "This image is too large for our image service. Replace it in Shopify with a smaller image, then run a new job.",
} as const;

/**
 * Machine-readable reason for a failed image (JobItem.errorCode, the API's errorCode and the
 * IMAGE_JOB_FAILED log). Mirrors itemFailureMessage: busy, timeout, out_of_memory, shopify,
 * access, unreadable, too_large, unknown. PermanentError and MerchantError carry their own code where the throw
 * site knows it: source_deleted, no_source_file, source_not_ready, source_download_failed,
 * backup_missing, no_output, changed_in_shopify, crashed, task_failed.
 */
export function itemFailureCode(error: unknown): string {
  if (error instanceof PermanentError) return error.code ?? "permanent";
  if (error instanceof MerchantError) return error.code ?? "unknown";
  if (error instanceof GpuServiceError) {
    if (error.code === "unsupported_image") return "unreadable";
    if (error.code === "image_too_large") return "too_large";
    if (error.code === "timeout") return "timeout";
    if (error.code === "out_of_memory") return "out_of_memory";
    return error.retryable ? "busy" : "unknown";
  }
  if (error instanceof ShopifyAuthError) return "access";
  if (error instanceof ShopifyGraphqlError || error instanceof FileProcessingError) return "shopify";
  return "unknown";
}

/** Merchant wording for a failed image task. */
export function itemFailureMessage(error: unknown): string {
  if (error instanceof PermanentError) return error.message; // written for merchants
  if (error instanceof MerchantError) return error.merchantMessage;
  if (error instanceof GpuServiceError) {
    if (error.code === "unsupported_image") return MESSAGES.unreadable;
    if (error.code === "image_too_large") return MESSAGES.tooLarge;
    if (error.code === "timeout") return MESSAGES.timeout;
    if (error.code === "out_of_memory") return MESSAGES.outOfMemory;
    // Unreachable, 5xx or 429: the service was busy or down.
    return error.retryable ? MESSAGES.busy : MESSAGES.unknown;
  }
  if (error instanceof ShopifyAuthError) return MESSAGES.access;
  if (error instanceof ShopifyGraphqlError || error instanceof FileProcessingError) return MESSAGES.shopify;
  return MESSAGES.unknown;
}

/** Merchant wording for a failed product read (Job.error). */
export function readFailureMessage(error: unknown): string {
  if (error instanceof PermanentError) return error.message;
  if (error instanceof MerchantError) return error.merchantMessage;
  if (error instanceof ShopifyAuthError) return MESSAGES.readAccess;
  return MESSAGES.read;
}
