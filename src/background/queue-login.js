// Whether the user is signed in to each site, judged from the names of the session cookies the
// browser holds. The values are never read.
function createLoginChecker(cookies) {
  const { SESSION_COOKIES, SIGN_IN_URL, SITE_LABEL, isSignedIn } = PageMediaLib.login;

  async function cookieNames(domain) {
    try {
      return (await cookies.getAll({ domain })).map(cookie => cookie.name);
    } catch {
      return [];
    }
  }

  async function status() {
    const result = {};
    for (const [platform, rule] of Object.entries(SESSION_COOKIES)) {
      result[platform] = {
        label: SITE_LABEL[platform],
        signedIn: isSignedIn(platform, await cookieNames(rule.domain)),
        signInUrl: SIGN_IN_URL[platform]
      };
    }
    return result;
  }

  // Plain functions, not methods: the engine hands them around without their owner.
  async function signedOutSites() {
    const result = await status();
    return Object.keys(result).filter(platform => !result[platform].signedIn);
  }

  return { status, signedOutSites };
}
