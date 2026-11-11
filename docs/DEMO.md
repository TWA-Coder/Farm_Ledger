# Demo script

A guided tour of every role on the local demo. Start the demo first (see the [README](../README.md)). Each step
names who is signed in: use **Sign out** (top right) and the one-click demo sign-ins on the sign-in page to switch.

## Demo script (8 minutes)

1. **Underwriter** (`underwriter` / `farmledger`): escrow balance, products, loss ratio (all zero), and the empty **Application desk**.
2. **Phone** (simulator at `/ussd`, a new number): **1. Register** -> National ID -> full name -> province 4 (Eastern) -> district 1 (Bugesera) -> code from the SMS -> PIN. The farmer is assigned to agent **Eric** (SMS to both).
   (Or register on the portal: *New farmer? Register* on the sign-in page. Either way the farmer can then sign in on
   the portal with that phone number and PIN.)
3. **Eric (agent)** (`eric` / `farmledger`): *My farmers* -> the new farmer -> **Record plot**; then **New application**: drought cover, documents, details, **Submit to the underwriter**.
4. **Underwriter**: *Application desk* -> open the application, check the form and documents, adjust the terms if needed, add conditions, **Send the contract**. The farmer and Eric get an SMS.
5. **Phone**: **6. My offers** -> review the contract (premium, subsidy, what you pay) -> **Pay by MoMo** -> PIN. Mobile Money confirms (simulated without MTN keys) and the policy is issued.
6. **Test tools**: *Weather scenario = Drought* on that plot -> automatic payout -> MoMo payout to the farmer's number, SMS for each step.
7. **Cattle**: Eric records a cow and applies for livestock cover; after acceptance, report a death and have **two vets** sign (`vet1`, `vet2`; 2-of-3).
8. **Underwriter**: loss ratio, reserved vs available funds, the policy document with the contract.

9. **Admin** (`admin` / `farmledger`): *Staff logins* -> **Add staff member** (e.g. a vet: licence, sector) -> give them the one-time password -> they sign in and choose their own. The underwriter adds agents the same way under *Agents*.

Real rainfall instead of the mock: `set DATA_SOURCE=nasa` (Windows) then `npm run oracle -- run`.


---
Back to the [README](../README.md) · other topics: [Roles and the insurance workflow](ROLES_AND_WORKFLOW.md) · [Web portal](PORTAL.md) · [Phones: USSD, SMS and phone accounts](PHONE_AND_SMS.md) · [Mobile Money (MTN MoMo)](MOBILE_MONEY.md) · [Smart contracts](CONTRACTS.md) · [Scope and requirements](SCOPE_AND_REQUIREMENTS.md)
