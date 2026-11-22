export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center font-display text-3xl font-semibold tracking-tight">PMS</p>
        {children}
      </div>
    </main>
  );
}
