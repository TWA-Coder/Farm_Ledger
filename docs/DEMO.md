# Demo script

A guided tour of every role on the local demo. Start the demo first (see the [README](../README.md)).

## Demo script (8 minutes)

1. **Underwriter**: escrow balance, products, loss ratio (all zero), and the empty **Application desk**.
2. **Phone** (simulator at `/ussd`, a new number): **1. Register** -> National ID -> province 4 (Eastern) -> district 1 (Bugesera) -> code from the SMS -> PIN. The farmer is assigned to agent **Eric** (SMS to both).
3. **Eric (agent)**: *My farmers* -> the new farmer -> **Record plot**; then **New application**: drought cover, documents, details, **Submit to the underwriter**.
4. **Underwriter**: *Application desk* -> open the application, check the form and documents, adjust the terms if needed, add conditions, **Send the contract**. The farmer and Eric get an SMS.
5. **Phone**: **6. My offers** -> review the contract (premium, subsidy, what you pay) -> **Pay by MoMo** -> PIN. Mobile Money confirms (simulated without MTN keys) and the policy is issued.
6. **Test tools**: *Weather scenario = Drought* on that plot -> automatic payout -> MoMo payout to the farmer's number, SMS for each step.
7. **Cattle**: Eric records a cow and applies for livestock cover; after acceptance, report a death and have **two vets** sign (2-of-3).
8. **Underwriter**: loss ratio, reserved vs available funds, the policy document with the contract.

Real rainfall instead of the mock: `set DATA_SOURCE=nasa` (Windows) then `npm run oracle -- run`.


---
Back to the [README](../README.md) · other topics: [Roles and the insurance workflow](ROLES_AND_WORKFLOW.md) · [Web portal](PORTAL.md) · [Phones: USSD, SMS and phone accounts](PHONE_AND_SMS.md) · [Mobile Money (MTN MoMo)](MOBILE_MONEY.md) · [Smart contracts](CONTRACTS.md) · [Scope and requirements](SCOPE_AND_REQUIREMENTS.md)
