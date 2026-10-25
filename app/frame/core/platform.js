// Compile-time boundary: native builds never activate website updates or browser networking.
export const androidApp = import.meta.env.APP_ANDROID === true;
