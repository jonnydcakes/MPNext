"use client";

import { ArrowRightOnRectangleIcon } from "@heroicons/react/24/outline";
import { unstable_rethrow } from "next/navigation";
import { MPUserProfile } from "@/lib/providers/ministry-platform/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { handleSignOut } from "./actions";

/**
 * Re-mints the session cookie cache before signing out.
 *
 * `handleSignOut` needs the session to find the user's ID token for
 * `id_token_hint`. It runs in a server action, which can read the session only
 * from the JWT cookie cache — its own in-memory store holds nothing (see
 * `src/lib/id-token-store.ts`). That cache lasts an hour, so after an hour with
 * no reload or tab switch the action would see no session and drop the hint,
 * leaving the user on MP's logged-out page. `GET /api/auth/get-session` runs in
 * the auth route handler, which does hold the session, and re-issues the
 * cookie. It must never block sign-out.
 */
async function refreshSessionCookie(): Promise<void> {
  try {
    await authClient.getSession();
  } catch {
    // Sign-out still proceeds; at worst it goes without the hint.
  }
}

interface UserMenuProps {
  onClose?: () => void;
  userProfile: MPUserProfile;
  children: React.ReactNode;
}

const userMenuItems = [
  {
    name: "Sign out",
    action: "signout",
    icon: ArrowRightOnRectangleIcon,
  },
];

export function UserMenu({ onClose, userProfile, children }: UserMenuProps) {
  const handleItemClick = async (action: string) => {
    if (onClose) {
      onClose();
    }
    if (action === "signout") {
      await refreshSessionCookie();
      try {
        await handleSignOut();
      } catch (err) {
        // `handleSignOut` ends in `redirect()`, and Next implements that by
        // throwing a NEXT_REDIRECT control-flow signal. `unstable_rethrow` must
        // stay the first statement here: it re-throws framework signals so a
        // successful sign-out still navigates, and lets only genuine failures
        // fall through to the alert. Remove it and every successful sign-out
        // pops an error instead of signing the user out.
        unstable_rethrow(err);
        const message = err instanceof Error ? err.message : "Sign out failed";
        alert(`Error: ${message}`);
      }
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-48 bg-[#344767] border-[#344767]"
        align="end"
      >
        <DropdownMenuLabel className="text-white">
          <div className="flex flex-col space-y-1">
            <p className="font-medium text-white">
              {userProfile.Nickname || userProfile.First_Name}{" "}
              {userProfile.Last_Name}
            </p>
            <p className="text-sm text-gray-300">{userProfile.Email_Address}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-gray-500" />
        {userMenuItems.map((item) => (
          <DropdownMenuItem
            key={item.name}
            onClick={() => handleItemClick(item.action)}
            className="cursor-pointer text-white hover:bg-[#2d3a5f] focus:bg-[#2d3a5f]"
          >
            <item.icon className="mr-2 h-4 w-4 text-white" />
            {item.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
