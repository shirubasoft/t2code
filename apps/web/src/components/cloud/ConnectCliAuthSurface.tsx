import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
export function ConnectCliAuthorizeSurface() {
  return (
    <AuthSurfaceShell>
      <h1 className="text-xl font-semibold">Local edition</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        T2 Code runs on this computer without a T3 account.
      </p>
    </AuthSurfaceShell>
  );
}
