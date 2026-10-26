import { useState, type FormEvent } from "react";
import { Activity, ArrowRight, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginPortal({
  onLogin,
  sessionError,
}: {
  onLogin: (username: string, password: string) => Promise<void>;
  sessionError: string | null;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await onLogin(username, password);
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#081426] px-5 py-10 text-slate-900">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(34,211,238,0.18),transparent_55%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(148,163,184,0.25)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.25)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:linear-gradient(to_bottom,black,transparent_80%)]" />

      <section className="relative w-full max-w-[430px] overflow-hidden rounded-2xl border border-white/15 bg-white shadow-[0_28px_100px_rgba(0,0,0,0.38)]">
        <div className="h-1 w-full bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500" />
        <div className="px-7 pb-8 pt-8 sm:px-9">
          <div className="mb-9 flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-slate-950 text-cyan-300 shadow-sm">
              <Activity className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <div className="text-lg font-semibold tracking-tight text-slate-900">
                Channel<span className="text-cyan-700">Pulse</span>
              </div>
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                Operations portal
              </div>
            </div>
          </div>

          <div className="mb-7">
            <p className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-800">
              <LockKeyhole className="h-3 w-3" aria-hidden="true" />
              Admin access
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Sign in to ChannelPulse</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Enter your admin credentials to access channel reporting and claims.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="login-username" className="text-sm font-medium text-slate-800">Username</label>
              <Input
                id="login-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                className="h-11 border-slate-300 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="login-password" className="text-sm font-medium text-slate-800">Password</label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                maxLength={256}
                required
                className="h-11 border-slate-300 bg-white"
              />
            </div>

            {(error || sessionError) && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                {error ?? sessionError}
              </p>
            )}

            <Button
              type="submit"
              disabled={isSubmitting || !username.trim() || !password}
              className="group h-11 w-full text-sm font-semibold"
            >
              {isSubmitting ? "Signing in…" : "Sign in"}
              {!isSubmitting && <ArrowRight className="ml-auto h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
            </Button>
          </form>

          <div className="mt-7 border-t border-slate-200 pt-5">
            <p className="text-xs leading-5 text-slate-500">
              Temporary single-admin login. Replace with named accounts before opening this app to a wider audience.
            </p>
          </div>
        </div>
      </section>
      <p className="absolute bottom-4 text-center text-[11px] tracking-wide text-slate-500">
        CHANNELPULSE · SECURE ADMIN SIGN-IN
      </p>
    </main>
  );
}
