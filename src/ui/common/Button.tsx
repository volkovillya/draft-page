import Link from "next/link";
import type { ComponentProps } from "react";

export type ButtonVariant = "primary" | "inverse" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap select-none " +
  "transition-[background-color,color,box-shadow,opacity] duration-150 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marker " +
  "disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0";

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover",
  inverse: "bg-inverse text-inverse-ink hover:opacity-90",
  secondary: "bg-panel text-ink ring-1 ring-line-strong ring-inset hover:bg-hover",
  ghost: "text-soft hover:bg-hover hover:text-ink",
  danger: "text-danger ring-1 ring-line-strong ring-inset hover:bg-hover",
};

export function buttonClass(variant: ButtonVariant = "secondary", extra = "", size: ButtonSize = "md"): string {
  return `${base} ${sizes[size]} ${variants[variant]} ${extra}`.trim();
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, className, size)} {...props} />;
}

/** An in-app link styled as a button. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass(variant, className, size)} {...props} />;
}

const iconBase =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-soft transition-colors " +
  "hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-marker " +
  "disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-hover aria-pressed:text-ink [&_svg]:size-[18px]";

/** A square icon-only button. `label` is required: it becomes the accessible name and tooltip. */
export function IconButton({
  label,
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return <button type={type} aria-label={label} title={label} className={`${iconBase} ${className}`} {...props} />;
}

export function iconLinkClass(extra = "") {
  return `${iconBase} ${extra}`;
}
