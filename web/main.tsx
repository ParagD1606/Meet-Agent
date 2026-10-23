import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { setUnauthorizedHandler } from "@/lib/api"
import { ToastProvider } from "@/ui/toast"
import { App } from "./app"
import "./globals.css"

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 } } })
// Any 401 drops the cached user, which sends the app to the sign-in screen.
setUnauthorizedHandler(() => qc.setQueryData(["me"], null))

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
