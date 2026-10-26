import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoginPortal } from "@/components/login-portal";

type AuthStatus = "checking" | "authenticated" | "unauthenticated" | "unavailable";
type AuthContextValue = {
  status: AuthStatus;
  sessionError: string | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Use the standard message below for an empty or non-JSON error response.
  }
  return "Sign-in could not be completed. Please try again.";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const statusRef = useRef<AuthStatus>("checking");
  const requestId = useRef(0);

  const updateStatus = useCallback((next: AuthStatus) => {
    if (statusRef.current === "authenticated" && next !== "authenticated") {
      queryClient.clear();
    }
    statusRef.current = next;
    setStatus(next);
  }, [queryClient]);

  const refreshSession = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const response = await fetch(`${API_BASE}/auth/session`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Session check failed");
      const session = await response.json() as { authenticated: boolean };
      if (currentRequest !== requestId.current) return;
      setSessionError(null);
      updateStatus(session.authenticated ? "authenticated" : "unauthenticated");
    } catch {
      if (currentRequest !== requestId.current) return;
      setSessionError("Could not confirm your sign-in. Check your connection and try again.");
      updateStatus(statusRef.current === "authenticated" ? "authenticated" : "unavailable");
    }
  }, [updateStatus]);

  useEffect(() => {
    void refreshSession();
    const interval = window.setInterval(() => void refreshSession(), 60_000);
    const onFocus = () => void refreshSession();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshSession]);

  const signIn = useCallback(async (username: string, password: string) => {
    ++requestId.current;
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw new Error(await responseError(response));
    ++requestId.current;
    await queryClient.cancelQueries();
    queryClient.clear();
    setSessionError(null);
    updateStatus("authenticated");
  }, [queryClient, updateStatus]);

  const signOut = useCallback(async () => {
    ++requestId.current;
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      // Clear the client-side session even if the server is temporarily unavailable.
    } finally {
      queryClient.clear();
      setSessionError(null);
      updateStatus("unauthenticated");
    }
  }, [queryClient, updateStatus]);

  return (
    <AuthContext.Provider value={{ status, sessionError, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, sessionError, signIn } = useAuth();

  if (status === "checking") {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-white">
        <div className="flex items-center gap-3 text-sm text-slate-300" role="status">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
          Checking your session…
        </div>
      </main>
    );
  }

  if (status !== "authenticated") {
    return <LoginPortal onLogin={signIn} sessionError={sessionError} />;
  }

  return children;
}
