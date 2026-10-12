import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthShell } from "@/components/layout/auth-shell";
import { RegisterForm } from "@/features/auth/register-form";
import { Skeleton } from "@/components/ui/feedback";

export const metadata: Metadata = { title: "Create account" };

function FormFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}

export default function RegisterPage() {
  return (
    <AuthShell
      title="Create your account"
      subtitle="One account works for teaching and for joining sessions."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <Suspense fallback={<FormFallback />}>
        <RegisterForm />
      </Suspense>
    </AuthShell>
  );
}
