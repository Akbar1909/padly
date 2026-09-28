import { z } from "zod";

/** Shared by the UI, the server and the worker. No server-only imports here. */

export const ASPECTS = ["1:1", "4:5"] as const;
export type Aspect = (typeof ASPECTS)[number];

const checkbox = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true" || v === "1");

export const PresetSchema = z.object({
  aspect: z.enum(ASPECTS).default("1:1"),
  marginPct: z.coerce.number().int().min(0).max(40).default(8),
  removeBg: checkbox,
  bgColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #FFFFFF")
    .default("#FFFFFF"),
  upscale: checkbox,
  upscaleThresholdPx: z.coerce.number().int().min(256).max(4096).default(1200),
  targetPx: z.coerce.number().int().min(512).max(4096).default(2048),
  aiMetadata: checkbox,
});

export type PresetSettings = z.infer<typeof PresetSchema>;

export const DEFAULT_PRESET: PresetSettings = {
  aspect: "1:1",
  marginPct: 8,
  removeBg: true,
  bgColor: "#FFFFFF",
  upscale: false,
  upscaleThresholdPx: 1200,
  targetPx: 2048,
  aiMetadata: true,
};

/** Parse preset fields from a submitted form (unchecked checkboxes are absent). */
export function parsePresetForm(form: FormData) {
  return PresetSchema.safeParse({
    aspect: form.get("aspect") ?? undefined,
    marginPct: form.get("marginPct") ?? undefined,
    removeBg: form.get("removeBg") ?? undefined,
    bgColor: (form.get("bgColor") as string | null)?.toUpperCase() || undefined,
    upscale: form.get("upscale") ?? undefined,
    upscaleThresholdPx: form.get("upscaleThresholdPx") ?? undefined,
    targetPx: form.get("targetPx") ?? undefined,
    aiMetadata: form.get("aiMetadata") ?? undefined,
  });
}

/** Pick the preset fields off a DB row or snapshot. */
export function toPresetSettings(p: PresetSettings): PresetSettings {
  return {
    aspect: p.aspect,
    marginPct: p.marginPct,
    removeBg: p.removeBg,
    bgColor: p.bgColor,
    upscale: p.upscale,
    upscaleThresholdPx: p.upscaleThresholdPx,
    targetPx: p.targetPx,
    aiMetadata: p.aiMetadata,
  };
}

/** Credits for one image: 1 to clean, +1 if AI upscaling runs on it. */
export function creditsFor(upscaleApplies: boolean): number {
  return upscaleApplies ? 2 : 1;
}

/**
 * Whether to ask the image service for AI upscaling. The reservation was made
 * from the size read when the job was created; if that didn't include the
 * upscaling credit, don't upscale (the merchant was quoted without it).
 */
export function upscaleCovered(preset: Pick<PresetSettings, "upscale">, creditsReserved: number): boolean {
  return preset.upscale && creditsReserved >= creditsFor(true);
}

/** Reservation once processing shows whether upscaling ran: it can drop, never grow. */
export function reservationAfterProcessing(creditsReserved: number, upscaleApplied: boolean): number {
  return Math.min(creditsReserved, creditsFor(upscaleApplied));
}

/** Credits charged when an image is applied: its price, never more than was reserved for it. */
export function applyCharge(upscaleApplied: boolean, creditsReserved: number): number {
  const price = creditsFor(upscaleApplied);
  return Math.min(price, creditsReserved || price);
}

/** Whether AI upscaling would run on an image of this size under this preset. */
export function isUpscaleEligible(
  preset: Pick<PresetSettings, "upscale" | "upscaleThresholdPx">,
  width: number | null | undefined,
  height: number | null | undefined,
): boolean {
  if (!preset.upscale || !width || !height) return false;
  return Math.min(width, height) < preset.upscaleThresholdPx;
}
