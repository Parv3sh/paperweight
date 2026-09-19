import { batchModifyCost, QUOTA_COST } from "./gmail-quota";

describe("batchModifyCost", () => {
  it("charges the documented flat cost for small batches", () => {
    expect(batchModifyCost(1)).toBe(50);
    expect(batchModifyCost(10)).toBe(50);
  });

  it("charges per message once that exceeds the flat cost", () => {
    expect(batchModifyCost(11)).toBe(55);
    expect(batchModifyCost(75)).toBe(75 * QUOTA_COST.modify);
    expect(batchModifyCost(1000)).toBe(5000);
  });
});
