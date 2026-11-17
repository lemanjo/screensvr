import type { Setting } from "../../src/shared/contracts.js";
import { Select } from "./Select.js";

export function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: Setting;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (setting.type === "boolean")
    return (
      <label className="toggle-field">
        <span>{setting.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  if (setting.type === "select")
    return (
      <Select
        label={setting.label}
        value={String(value)}
        onChange={onChange}
        options={setting.options}
      />
    );
  if (setting.type === "color")
    return (
      <label>
        {setting.label}
        <div className="color-field">
          <input
            type="color"
            value={String(value)}
            onChange={(event) => onChange(event.target.value)}
          />
          <span>{String(value).toUpperCase()}</span>
        </div>
      </label>
    );
  return (
    <label>
      {setting.label}
      <input
        type={setting.type === "number" ? "number" : "text"}
        value={String(value)}
        min={setting.type === "number" ? setting.min : undefined}
        max={setting.type === "number" ? setting.max : undefined}
        step={setting.type === "number" ? (setting.step ?? "any") : undefined}
        maxLength={setting.type === "text" ? 200 : undefined}
        required={setting.type === "number"}
        onChange={(event) =>
          onChange(
            setting.type === "number"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </label>
  );
}
