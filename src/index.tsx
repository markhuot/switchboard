import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useState } from "react"

function App() {
  const [status, setStatus] = useState("idle")

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") {
      process.exit(0)
    }
  })

  return (
    <box flexDirection="column" style={{ padding: 1 }}>
      <box style={{ border: true, borderStyle: "single", borderColor: "#4a4a4a", padding: 1 }}>
        <ascii-font text="Switchboard" font="tiny" />
      </box>

      <box style={{ marginTop: 1, border: true, borderColor: "#333", padding: 1 }}>
        <text>
          <span fg="#888">Status: </span>
          <span fg="#22c55e">{status}</span>
        </text>
      </box>

      <box style={{ marginTop: 1, flexDirection: "column", gap: 0 }}>
        <text fg="#555">No agents connected. Waiting for dispatch...</text>
      </box>

      <box style={{ marginTop: 1 }}>
        <text fg="#444">Press <span fg="#888">q</span> or <span fg="#888">ESC</span> to quit</text>
      </box>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
