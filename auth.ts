import { getServerSession, type DefaultSession, type NextAuthOptions } from "next-auth";
import Google from "next-auth/providers/google";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      googleName: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    googleName?: string;
    picture?: string | null;
  }
}

export const authOptions: NextAuthOptions = {
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt"
  },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
      authorization: {
        params: {
          prompt: "select_account"
        }
      },
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: typeof profile.picture === "string" ? profile.picture : null
        };
      }
    })
  ],
  callbacks: {
    jwt({ token, user, profile }) {
      const googleProfile = profile as { name?: string; picture?: string } | undefined;

      if (user) {
        token.googleName = user.name ?? "";
        token.picture = user.image ?? null;
      }

      if (!token.googleName && typeof googleProfile?.name === "string") {
        token.googleName = googleProfile.name;
      }

      if (!token.picture && typeof googleProfile?.picture === "string") {
        token.picture = googleProfile.picture;
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.googleName = token.googleName ?? session.user.name ?? "";
        session.user.image =
          typeof token.picture === "string" ? token.picture : (token.picture ?? null);
      }

      return session;
    }
  }
};

export function auth() {
  return getServerSession(authOptions);
}
