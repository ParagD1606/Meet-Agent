import { useId, cloneElement, type ReactElement } from "react"

/** CSS tooltip: shows on hover and keyboard focus, wired with aria-describedby. */
export function Tooltip({ text, children, side }: { text: string; children: ReactElement<{ "aria-describedby"?: string }>; side?: "right" | "bottom" }) {
  const id = useId()
  return (
    <span className="tip-wrap">
      {cloneElement(children, { "aria-describedby": id })}
      <span id={id} role="tooltip" className="tip" data-side={side}>{text}</span>
    </span>
  )
}
