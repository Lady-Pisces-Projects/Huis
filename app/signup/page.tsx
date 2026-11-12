import { SignInPanel } from "../signin/panel";

export const dynamic = "force-dynamic";

/** Where the huislaw.ai website's "Start Your 7-Day Free Trial" buttons go (https://app.huislaw.ai/signup). */
export default async function SignUp() {
  return <SignInPanel mode="signup" />;
}
