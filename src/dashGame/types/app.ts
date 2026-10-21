export type Step =
  | "loading"
  | "splash"
  | "sign-in"
  | "create-account"
  | "verify-email"
  | "create-username"
  | "complete-profile"
  | "forgot-password"
  | "reset-password"
  | "recommend-intro"
  | "personalize-swipe"
  | "personalize-complete"
  | "pref-gender"
  | "pref-intro"
  | "pref-swipe"
  | "welcome-reward"
  | "app";

export type AppTab = "home" | "feed" | "hub" | "bag" | "profile";

/** Full-screen destinations from Top Navigation (hide footer while open) */
export type AppOverlay = "settings" | "store" | "inbox" | "cart" | "pack-pocket" | null;

export type GenderInterest = "male" | "female" | "both";

export type OnboardingData = {
  email: string;
  password: string;
  username: string;
  displayName: string;
  avatar: string | null;
  genderInterest: GenderInterest | null;
  likedCreators: string[];
  passedCreators: string[];
  welcomeClaimed: boolean;
  referralCode: string;
  referralApplied: boolean;
  homeTutorialDone: boolean;
  coins: number;
  diamonds: number;
};

export const STEP_LABEL: Record<Step, string> = {
  loading: "Loading",
  splash: "Splash Hook",
  "sign-in": "Login",
  "create-account": "Sign Up · 1",
  "verify-email": "Sign Up · 2",
  "create-username": "Sign Up · 3",
  "complete-profile": "Complete Profile",
  "forgot-password": "Forgot Password",
  "reset-password": "Reset Password",
  "recommend-intro": "Recommend · Intro",
  "personalize-swipe": "Recommend · Swipe",
  "personalize-complete": "Recommend · Ready",
  "pref-gender": "Preference · Gender",
  "pref-intro": "Preference · Intro",
  "pref-swipe": "Preference · Swipe",
  "welcome-reward": "Welcome Reward",
  app: "App",
};

export const SPLASH_SLIDES = [
  {
    title: "Sugar Scratch",
    hook: "Collect beauty cards from real creators and AI characters.",
    cta: "Next",
  },
  {
    title: "Scratch. Collect. Win.",
    hook: "Open packs, scratch to reveal, and earn Coins along the way.",
    cta: "Next",
  },
  {
    title: "Your collection awaits",
    hook: "Discover, streak daily rewards, and chase the cards you want most.",
    cta: "Get started",
  },
] as const;

export const GENDER_OPTIONS: { id: GenderInterest; label: string }[] = [
  { id: "female", label: "Female" },
  { id: "male", label: "Male" },
  { id: "both", label: "Both" },
];

export const DEMO_CREATORS = [
  { id: "c1", name: "Nancy Allison", tag: "Lifestyle · Daily drops" },
  { id: "c2", name: "Jane Smith", tag: "Premium photo packs" },
  { id: "c3", name: "Alex Rivera", tag: "Limited editions" },
  { id: "c4", name: "Sam Chen", tag: "Weekend bonuses" },
  { id: "c5", name: "Jordan Lee", tag: "Collector series" },
  { id: "c6", name: "Riley Brooks", tag: "Coins surprise packs" },
  { id: "c7", name: "Casey Morgan", tag: "Featured weekly" },
  { id: "c8", name: "Taylor Quinn", tag: "VIP scratch vault" },
] as const;

/** Configurable minimum preference swipes (spec: currently 5) */
export const MIN_PREF_SWIPES = 5;

export const TAKEN_USERNAMES = new Set(["taken", "admin", "sugar", "test"]);

export const AVATAR_OPTIONS = ["🌹", "✨", "💎", "🔥", "💋", "🌙"] as const;

export const WELCOME_REWARDS = [
  { id: "r1", label: "Starter Scratch Pack", detail: "1 pack" },
  { id: "r2", label: "Coins", detail: "+50" },
  { id: "r3", label: "Daily Streak Boost", detail: "Day 1 locked in" },
] as const;
