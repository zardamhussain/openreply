"use client";

import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { useSearchParams } from "next/navigation";
import { Notice, type NoticeTone } from "@/components/connect-notice";

const MESSAGES: Record<string, { tone: NoticeTone; title: StaticMessageKey; detail: StaticMessageKey }> = {
  denied: {
    tone: "warning",
    title: "Threads connection cancelled",
    detail:
      "You declined the permission prompt on Threads. Start again and accept all requested permissions.",
  },
  invalid: {
    tone: "error",
    title: "Threads connection expired",
    detail:
      "The login link was missing or older than 10 minutes. Click Connect Threads to start a fresh attempt.",
  },
  forbidden: {
    tone: "error",
    title: "Not permitted",
    detail:
      "Only workspace owners and admins can connect a Threads account.",
  },
  already_connected: {
    tone: "warning",
    title: "Account already connected",
    detail:
      "That Threads account is connected to another workspace. Disconnect it there first, or connect a different account.",
  },
};

export function ThreadsConnectNotice() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const status = searchParams.get("threads");

  if (!status) return null;

  if (status === "misconfigured") {
    const missing = (searchParams.get("missing") ?? "")
      .split(",")
      .filter(Boolean);

    return (
      <Notice tone="error" title={t("Threads app not configured")}>
        <p>
          {t("Set")}{" "}
          {missing.length > 0
            ? t("these environment variables")
            : t("the required environment variables")}{" "}
          {t("and restart the server:")}
        </p>
        {missing.length > 0 && (
          <ul className="mt-2 space-y-1">
            {missing.map((name) => (
              <li key={name} className="font-mono text-xs">
                {name}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2">
          {t("See docs/setup.md for how to obtain each value.")}
        </p>
        <p className="mt-2">
          {t("You can also connect a Threads account through Zernio, without a Meta app.")}
        </p>
      </Notice>
    );
  }

  if (status === "failed") {
    const reason = searchParams.get("reason");

    return (
      <Notice tone="error" title={t("Threads connection failed")}>
        <p>
          {t("Threads accepted the login but the connection could not be completed. This is usually a mismatched redirect URI or an app that is missing the required permissions.")}
        </p>
        {reason && (
          <p className="mt-2 font-mono text-xs break-words opacity-80">
            {reason}
          </p>
        )}
      </Notice>
    );
  }

  const known = MESSAGES[status];
  if (!known) return null;

  return (
    <Notice tone={known.tone} title={t(known.title)}>
      <p>{t(known.detail)}</p>
    </Notice>
  );
}
