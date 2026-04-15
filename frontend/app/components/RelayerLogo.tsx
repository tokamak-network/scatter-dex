"use client";

import { useState } from "react";
import { User } from "lucide-react";

interface Props {
  logoUrl?: string;
  size: number;
  className?: string;
}

// Shared logo+fallback block. Resets the broken-flag when logoUrl changes so
// editing a profile gives the new URL a fair chance to load — using the
// derived-state-during-render pattern (React docs § "Resetting state with
// a key" alternative).
export default function RelayerLogo({ logoUrl, size, className = "" }: Props) {
  const [broken, setBroken] = useState(false);
  const [lastUrl, setLastUrl] = useState(logoUrl);
  if (logoUrl !== lastUrl) {
    setLastUrl(logoUrl);
    setBroken(false);
  }

  const showImg = logoUrl && !broken;
  return (
    <div
      className={`rounded-full bg-primary/10 flex items-center justify-center overflow-hidden ${className}`}
      style={{ width: size, height: size }}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          width={size}
          height={size}
          className="object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <User className="text-primary" style={{ width: size * 0.5, height: size * 0.5 }} />
      )}
    </div>
  );
}
