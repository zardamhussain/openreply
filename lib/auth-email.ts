type MagicLinkParams = {
  identifier: string;
  url: string;
};

export function getDevelopmentMagicLinkLogger(
  nodeEnv: string | undefined,
  log: (message: string) => void = console.info
) {
  if (nodeEnv !== "development") return undefined;
  return ({ identifier, url }: MagicLinkParams) => {
    log(`OpenReply local sign-in link for ${identifier}: ${url}`);
  };
}
