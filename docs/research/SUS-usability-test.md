# Usability test: System Usability Scale (NFR-05)

NFR-05 says FarmLedger should reach a System Usability Scale (SUS) score of **80 or more**. This page explains how to
measure it with real users and how to score and report the results. Report whatever score you get, including a
score below 80. An honest low score with an analysis counts for more than an unmeasured target.

## 1. Who to test with

| Group | Channel they test | Minimum |
|---|---|---|
| Farmers (smallholders, ideally with a basic phone) | USSD simulator or a real phone through the Africa's Talking sandbox | 5 |
| Insurance agents (or people in a similar role: SACCO, cooperative or extension staff) | Web portal, agent desk | 3 |
| Veterinarians (or animal health officers) | Web portal, vet queue | 2 |

Five users per group find most usability problems. Score each group separately, because farmers on USSD and staff
on the web use different interfaces.

Before each session, get informed consent (see the ethics section of the report). Collect only first names or codes
(F1, F2, A1, ...), not National ID numbers or phone numbers.

## 2. Tasks (give them in the user's language; do not show them how)

**Farmers (USSD)**
1. Register with your name, a National ID number (use a test number) and a PIN.
2. Check your policies (*My policies*).
3. Open *My offers*, read the contract and accept it (payment is simulated).
4. Report a dead cow (*Report a claim*).
5. Check the status of your claim.
6. Switch the menus to the other language and back.

**Agents (web)**
1. Sign in, find a farmer assigned to you and start an application.
2. Fill in the form and attach the documents.
3. Check whether the underwriter has drafted the contract.

**Vets (web)**
1. Sign in and open the claim queue.
2. Open a pending cattle claim and approve or reject it.

For every task, record: completed (yes / with help / no), time taken, errors, and what the user said.

## 3. The questionnaire (after the tasks)

Users answer each statement from **1 = strongly disagree** to **5 = strongly agree**. Use the standard wording below and
do not change it. For Kinyarwanda, have the translation done or checked by a native speaker before the first
session, and say who checked it in the report.

1. I think that I would like to use this system frequently.
2. I found the system unnecessarily complex.
3. I thought the system was easy to use.
4. I think that I would need the support of a technical person to be able to use this system.
5. I found the various functions in this system were well integrated.
6. I thought there was too much inconsistency in this system.
7. I would imagine that most people would learn to use this system very quickly.
8. I found the system very cumbersome to use.
9. I felt very confident using the system.
10. I needed to learn a lot of things before I could get going with this system.

With farmers who do not read easily, read each statement aloud and let them point to a 1-5 scale drawn on paper.

## 4. Recording and scoring

Put the answers in a CSV file, one row per user (an example is in `docs/research/sus-responses.example.csv`):

```
participant,group,q1,q2,q3,q4,q5,q6,q7,q8,q9,q10
F1,farmer,4,2,4,3,4,2,4,2,4,3
```

Then run:

```
npm run sus -- path/to/your-responses.csv
```

The script checks every answer is between 1 and 5 and calculates each user's score: odd items score (answer - 1),
even items score (5 - answer), and the total is multiplied by 2.5, giving 0 to 100. It then prints the mean,
standard deviation, minimum and maximum per group and overall, and whether the mean reaches NFR-05.

Common interpretation: 68 is about average, 80 or more is good to excellent.

## 5. What to put in the report

* Who took part (number, group, channel, where and when), anonymised.
* Task completion rates and the main problems you saw, with what you changed in response.
* SUS score per group and overall, against the target of 80.
* Limitations: small sample, simulator instead of a real network, test money, the tester was also the developer.
* Keep the signed consent forms and the raw CSV as evidence (do not put names in the repo).
