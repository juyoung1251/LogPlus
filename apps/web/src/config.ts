const envBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const configuredBaseUrl = envBaseUrl || (
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : "http://127.0.0.1:8000"
);

export const API_BASE_URL = configuredBaseUrl.replace(/\/$/, "");
