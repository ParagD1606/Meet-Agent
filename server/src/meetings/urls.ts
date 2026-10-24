import { config } from "../config";

const base = () => config.PUBLIC_URL.replace(/\/$/, "");
export const meetingUrl = (id: string) => `${base()}/meetings?meeting=${encodeURIComponent(id)}`;
export const tasksUrl = () => `${base()}/tasks`;
export const slackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
