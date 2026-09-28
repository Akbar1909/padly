import type { PresetSettings } from "../lib/presets";
import { COLUMNS_2 } from "./layout";

/** Spread a boolean attribute only when true (React 18 would render `checked="false"` as checked). */
const on = (flag: boolean, attr: string) => (flag ? { [attr]: true } : {});

/**
 * The "Clean & match" preset fields. Polaris fields are form-associated, so
 * they submit with the surrounding <form> under their `name`.
 */
export function PresetFields({ preset, errors }: { preset: PresetSettings; errors?: Record<string, string> }) {
  return (
    <s-stack direction="block" gap="base">
      <s-query-container>
        <s-grid gridTemplateColumns={COLUMNS_2} gap="base">
          <s-select label="Canvas" name="aspect" value={preset.aspect}>
            <s-option value="1:1">Square (1:1)</s-option>
            <s-option value="4:5">Portrait (4:5)</s-option>
          </s-select>
          <s-number-field
            label="Margin"
            name="marginPct"
            value={String(preset.marginPct)}
            min={0}
            max={40}
            step={1}
            suffix="%"
            details="Empty space kept on each side of the product"
            error={errors?.marginPct}
          />
        </s-grid>
      </s-query-container>

      <s-checkbox
        label="Remove background"
        name="removeBg"
        value="on"
        details="Off: keep the original background and only pad and centre"
        {...on(preset.removeBg, "checked")}
      />
      <s-color-field
        label="Background colour"
        name="bgColor"
        value={preset.bgColor}
        error={errors?.bgColor}
      />

      <s-divider />

      <s-checkbox
        label="AI upscaling for small images"
        name="upscale"
        value="on"
        details="AI upscaling can alter fine details. Images with text or labels use a safe non-AI resize instead. +1 credit per upscaled image."
        {...on(preset.upscale, "checked")}
      />
      <s-query-container>
        <s-grid gridTemplateColumns={COLUMNS_2} gap="base">
          <s-number-field
            label="Upscale when short side is under"
            name="upscaleThresholdPx"
            value={String(preset.upscaleThresholdPx)}
            min={256}
            max={4096}
            step={50}
            suffix="px"
            error={errors?.upscaleThresholdPx}
          />
          <s-number-field
            label="Output width"
            name="targetPx"
            value={String(preset.targetPx)}
            min={512}
            max={4096}
            step={64}
            suffix="px"
            details="Small images are only enlarged when AI upscaling is on (photos with text or labels get a standard resize instead)"
            error={errors?.targetPx}
          />
        </s-grid>
      </s-query-container>
      <s-checkbox
        label="Write AI metadata on upscaled images"
        name="aiMetadata"
        value="on"
        details="Adds the IPTC “digital source type” tag Google Merchant Center expects on AI-edited images"
        {...on(preset.aiMetadata, "checked")}
      />
    </s-stack>
  );
}
