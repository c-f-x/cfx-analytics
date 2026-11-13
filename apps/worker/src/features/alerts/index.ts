// What alerts offers: the weekly email, built from a product's week of numbers,
// and the dashboard's routes for its addresses.

export {
  lastWeeks,
  type ProductWeek,
  productWeekOf,
  receives,
  recipientsOf,
  type Week,
  type WeekAnswers,
  type WeeklyEmail,
  weeklyEmail,
  weekQueries,
} from "./core.ts";
export { type AddressRow, mountEmails } from "./http.ts";
export { listAddedAddresses } from "./store.ts";
