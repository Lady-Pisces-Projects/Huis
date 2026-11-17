import { SignInPanel } from "./panel";

export const dynamic = "force-dynamic";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return <SignInPanel reason={reason} mode="signin" />;
}
