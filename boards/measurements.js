// scripts/build_boards.py에서 생성합니다.
window.DAEVANION_MEASUREMENTS = [
  {
    "id": "2026-11-02-attack-5-01",
    "recordedOn": "2026-11-02",
    "grade": "Common",
    "type": "Stat",
    "name": "공격력",
    "effects": [
      "추가 공격력 +5"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990034,
    "after": 989595,
    "key": "[\"Common\",\"Stat\",\"공격력\",[\"추가 공격력 +5\"]]",
    "power": 439
  },
  {
    "id": "2026-11-02-critical-10-01",
    "recordedOn": "2026-11-02",
    "grade": "Common",
    "type": "Stat",
    "name": "치명타",
    "effects": [
      "치명타 +10"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990034,
    "after": 989922,
    "key": "[\"Common\",\"Stat\",\"치명타\",[\"치명타 +10\"]]",
    "power": 112
  },
  {
    "id": "2026-11-02-defense-50-01",
    "recordedOn": "2026-11-02",
    "grade": "Common",
    "type": "Stat",
    "name": "방어력",
    "effects": [
      "추가 방어력 +50"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 989922,
    "after": 989829,
    "note": "치명타 +10 노드를 복원하지 않은 상태",
    "key": "[\"Common\",\"Stat\",\"방어력\",[\"추가 방어력 +50\"]]",
    "power": 93
  },
  {
    "id": "2026-11-02-attack-5-02",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Common",
    "type": "Stat",
    "name": "공격력",
    "effects": [
      "추가 공격력 +5"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 989829,
    "after": 989390,
    "note": "네자칸에서 치명타 +10과 추가 방어력 +50을 복원하지 않은 상태로 재측정",
    "key": "[\"Common\",\"Stat\",\"공격력\",[\"추가 공격력 +5\"]]",
    "power": 439
  },
  {
    "id": "2026-11-02-lightning-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Legend",
    "type": "SkillLevel",
    "name": "스킬 레벨 상승 - 벼락 난사",
    "effects": [
      "벼락 난사 +1"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 989390,
    "after": 989290,
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 벼락 난사\",[\"벼락 난사 +1\"]]",
    "power": 100
  },
  {
    "id": "2026-11-02-defense-500-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Unique",
    "type": "Stat",
    "name": "추가 방어력",
    "effects": [
      "추가 방어력 +500"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 989290,
    "after": 988308,
    "key": "[\"Unique\",\"Stat\",\"추가 방어력\",[\"추가 방어력 +500\"]]",
    "power": 982
  },
  {
    "id": "2026-11-02-warm-blessing-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Rare",
    "type": "SkillLevel",
    "name": "스킬 레벨 상승 - 따뜻한 가호",
    "effects": [
      "따뜻한 가호 +1"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 988308,
    "after": 988108,
    "coordinates": [
      10,
      15
    ],
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 따뜻한 가호\",[\"따뜻한 가호 +1\"]]",
    "power": 200
  },
  {
    "id": "2026-11-02-attack-50-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Unique",
    "type": "Stat",
    "name": "추가 공격력",
    "effects": [
      "추가 공격력 +50"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 988108,
    "after": 983650,
    "coordinates": [
      8,
      15
    ],
    "key": "[\"Unique\",\"Stat\",\"추가 공격력\",[\"추가 공격력 +50\"]]",
    "power": 4458
  },
  {
    "id": "2026-11-02-combat-speed-inferred-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Unique",
    "type": "Stat",
    "name": "전투 속도",
    "effects": [
      "전투 속도 +2.5%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990034,
    "after": 985545,
    "excludedPower": 439,
    "excludedObservationId": "2026-11-02-attack-5-01",
    "basis": "inferred",
    "coordinates": [
      1,
      1
    ],
    "note": "전체 복원 후 (1,1) 전투 속도와 (1,2) 추가 공격력 +5를 함께 해제했습니다. 총 감소 4,489에서 기존 공격력 측정값 439를 제외한 추정값입니다.",
    "key": "[\"Unique\",\"Stat\",\"전투 속도\",[\"전투 속도 +2.5%\"]]",
    "power": 4050
  },
  {
    "id": "2026-11-02-healing-power-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Rare",
    "type": "SkillLevel",
    "name": "스킬 레벨 상승 - 치유력 강화",
    "effects": [
      "치유력 강화 +1"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990034,
    "after": 989834,
    "coordinates": [
      15,
      3
    ],
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 치유력 강화\",[\"치유력 강화 +1\"]]",
    "power": 200
  },
  {
    "id": "2026-11-02-cooldown-inferred-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Unique",
    "type": "Stat",
    "name": "재시전 시간 감소",
    "effects": [
      "재시전 시간 감소 +2.5%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 989834,
    "after": 988991,
    "excludedPower": 93,
    "excludedObservationId": "2026-11-02-defense-50-01",
    "basis": "inferred",
    "coordinates": [
      15,
      1
    ],
    "note": "치유력 강화를 복원하지 않고 (15,2) 추가 방어력 +50과 (15,1) 재시전 시간 감소를 함께 해제했습니다. 총 감소 843에서 기존 방어력 측정값 93을 제외한 추정값입니다.",
    "key": "[\"Unique\",\"Stat\",\"재시전 시간 감소\",[\"재시전 시간 감소 +2.5%\"]]",
    "power": 750
  },
  {
    "id": "2026-11-02-critical-resistance-10-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Common",
    "type": "Stat",
    "name": "치명타 저항",
    "effects": [
      "치명타 저항 +10"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990034,
    "after": 990024,
    "key": "[\"Common\",\"Stat\",\"치명타 저항\",[\"치명타 저항 +10\"]]",
    "power": 10
  },
  {
    "id": "2026-11-02-mana-50-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Common",
    "type": "Stat",
    "name": "최대 정신력",
    "effects": [
      "정신력 +50"
    ],
    "operation": "activate",
    "nodeCount": 1,
    "before": 990024,
    "after": 990038,
    "coordinates": [
      6,
      8
    ],
    "note": "치명타 저항 +10을 해제한 상태에서 정신력 +50 한 노드를 추가했습니다.",
    "key": "[\"Common\",\"Stat\",\"최대 정신력\",[\"정신력 +50\"]]",
    "power": 14
  },
  {
    "id": "2026-11-02-health-100-01",
    "recordedOn": "2026-11-02",
    "boardId": 71,
    "grade": "Common",
    "type": "Stat",
    "name": "최대 생명력",
    "effects": [
      "생명력 +100"
    ],
    "operation": "activate",
    "nodeCount": 1,
    "before": 990024,
    "after": 990048,
    "note": "정신력 +50의 14 CP를 제거해 990,024로 돌아간 뒤 생명력 +100을 추가했습니다. 치명타 저항 해제 상태는 유지했습니다.",
    "key": "[\"Common\",\"Stat\",\"최대 생명력\",[\"생명력 +100\"]]",
    "power": 24
  },
  {
    "id": "2026-11-02-damage-resistance-01",
    "recordedOn": "2026-11-02",
    "boardId": 72,
    "grade": "Unique",
    "type": "Stat",
    "name": "피해 내성",
    "effects": [
      "피해 내성 +5%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990048,
    "after": 987606,
    "coordinates": [
      1,
      1
    ],
    "note": "피해 내성이 38%에서 33%로 감소했습니다.",
    "key": "[\"Unique\",\"Stat\",\"피해 내성\",[\"피해 내성 +5%\"]]",
    "power": 2442
  },
  {
    "id": "2026-11-02-evasion-75-01",
    "recordedOn": "2026-11-02",
    "boardId": 72,
    "grade": "Unique",
    "type": "Stat",
    "name": "회피",
    "effects": [
      "추가 회피 +75"
    ],
    "operation": "activate",
    "nodeCount": 1,
    "before": 987606,
    "after": 987686,
    "note": "피해 내성을 복구하지 않고 회피를 추가했습니다.",
    "key": "[\"Unique\",\"Stat\",\"회피\",[\"추가 회피 +75\"]]",
    "power": 80
  },
  {
    "id": "2026-11-02-damage-amplification-inferred-01",
    "recordedOn": "2026-11-02",
    "boardId": 72,
    "grade": "Unique",
    "type": "Stat",
    "name": "피해 증폭",
    "effects": [
      "피해 증폭 +5%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 987686,
    "after": 982520,
    "excludedPower": 66,
    "adjustments": [
      {
        "observationId": "2026-11-02-evasion-75-01",
        "operation": "deactivate",
        "nodeCount": 1
      },
      {
        "observationId": "2026-11-02-mana-50-01",
        "operation": "activate",
        "nodeCount": 1
      }
    ],
    "basis": "inferred",
    "coordinates": [
      15,
      1
    ],
    "note": "총 감소 5,166 CP에서 회피 제거 80 CP와 정신력 추가 14 CP의 순감소 66 CP를 제외한 5,100 CP 추정값입니다.",
    "key": "[\"Unique\",\"Stat\",\"피해 증폭\",[\"피해 증폭 +5%\"]]",
    "power": 5100
  },
  {
    "id": "2026-11-02-accuracy-75-01",
    "recordedOn": "2026-11-02",
    "boardId": 72,
    "grade": "Unique",
    "type": "Stat",
    "name": "명중",
    "effects": [
      "추가 명중 +75"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 982520,
    "after": 981824,
    "coordinates": [
      15,
      8
    ],
    "key": "[\"Unique\",\"Stat\",\"명중\",[\"추가 명중 +75\"]]",
    "power": 696
  },
  {
    "id": "2026-11-02-damage-resistance-02",
    "recordedOn": "2026-11-02",
    "boardId": 72,
    "grade": "Unique",
    "type": "Stat",
    "name": "피해 내성",
    "effects": [
      "피해 내성 +5%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 981824,
    "after": 979382,
    "coordinates": [
      15,
      15
    ],
    "note": "두 번째 피해 내성 노드도 첫 측정과 같은 2,442 CP 감소를 확인했습니다.",
    "key": "[\"Unique\",\"Stat\",\"피해 내성\",[\"피해 내성 +5%\"]]",
    "power": 2442
  },
  {
    "id": "2026-11-02-critical-damage-resistance-01",
    "recordedOn": "2026-11-02",
    "boardId": 73,
    "grade": "Unique",
    "type": "Stat",
    "name": "치명타 피해 내성",
    "effects": [
      "치명타 피해 내성 +5%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990048,
    "after": 988830,
    "note": "지켈 복원 후 기준값에서 치명타 피해 내성 한 노드를 해제했습니다.",
    "key": "[\"Unique\",\"Stat\",\"치명타 피해 내성\",[\"치명타 피해 내성 +5%\"]]",
    "power": 1218
  },
  {
    "id": "2026-11-02-critical-damage-amplification-inferred-01",
    "recordedOn": "2026-11-02",
    "boardId": 73,
    "grade": "Unique",
    "type": "Stat",
    "name": "치명타 피해 증폭",
    "effects": [
      "치명타 피해 증폭 +5%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990048,
    "after": 987149,
    "excludedPower": 439,
    "excludedObservationId": "2026-11-02-attack-5-01",
    "basis": "inferred",
    "note": "치명타 피해 내성 복원 후 추가 공격력 +5와 함께 해제했습니다. 총 감소 2,899에서 공격력 439를 제외한 2,460 CP입니다.",
    "key": "[\"Unique\",\"Stat\",\"치명타 피해 증폭\",[\"치명타 피해 증폭 +5%\"]]",
    "power": 2460
  },
  {
    "id": "2026-11-02-multi-hit-accuracy-01",
    "recordedOn": "2026-11-02",
    "boardId": 74,
    "grade": "Unique",
    "type": "Stat",
    "name": "다단 히트 적중",
    "effects": [
      "다단 히트 적중 +3%"
    ],
    "operation": "deactivate",
    "nodeCount": 1,
    "before": 990048,
    "after": 988833,
    "note": "앞서 해제한 바이젤 노드를 모두 복원한 기준 990,048에서 한 노드를 해제했습니다.",
    "key": "[\"Unique\",\"Stat\",\"다단 히트 적중\",[\"다단 히트 적중 +3%\"]]",
    "power": 1215
  },
  {
    "id": "2026-11-02-multi-hit-resistance-01",
    "recordedOn": "2026-11-02",
    "boardId": 74,
    "grade": "Unique",
    "type": "Stat",
    "name": "다단 히트 저항",
    "effects": [
      "다단 히트 저항 +3%"
    ],
    "operation": "activate",
    "nodeCount": 1,
    "before": 988833,
    "after": 988923,
    "note": "다단 히트 적중을 복원하지 않고 저항 한 노드를 추가했습니다.",
    "key": "[\"Unique\",\"Stat\",\"다단 히트 저항\",[\"다단 히트 저항 +3%\"]]",
    "power": 90
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 주신의 가호\",[\"주신의 가호 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 주신의 가호\",[\"주신의 가호 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 불사의 장막\",[\"불사의 장막 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 불사의 장막\",[\"불사의 장막 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 주신의 은총\",[\"주신의 은총 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 주신의 은총\",[\"주신의 은총 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 따뜻한 가호\",[\"따뜻한 가호 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 따뜻한 가호\",[\"따뜻한 가호 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 치유력 강화\",[\"치유력 강화 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 치유력 강화\",[\"치유력 강화 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 생존 의지\",[\"생존 의지 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 생존 의지\",[\"생존 의지 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 찬란한 가호\",[\"찬란한 가호 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 찬란한 가호\",[\"찬란한 가호 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 대지의 은총\",[\"대지의 은총 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 대지의 은총\",[\"대지의 은총 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 집중의 기도\",[\"집중의 기도 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 집중의 기도\",[\"집중의 기도 +1\"]]"
  },
  {
    "id": "2026-11-02-passive-fixed:[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 회복 차단\",[\"회복 차단 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Rare",
    "power": 200,
    "basis": "fixed",
    "note": "사용자가 확인한 패시브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Rare\",\"SkillLevel\",\"스킬 레벨 상승 - 회복 차단\",[\"회복 차단 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 벽력\",[\"벽력 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 벽력\",[\"벽력 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 신성한 기운\",[\"신성한 기운 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 신성한 기운\",[\"신성한 기운 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 대지의 응보\",[\"대지의 응보 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 대지의 응보\",[\"대지의 응보 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 치유의 빛\",[\"치유의 빛 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 치유의 빛\",[\"치유의 빛 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 재생의 빛\",[\"재생의 빛 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 재생의 빛\",[\"재생의 빛 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 단죄\",[\"단죄 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 단죄\",[\"단죄 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 고통의 연쇄\",[\"고통의 연쇄 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 고통의 연쇄\",[\"고통의 연쇄 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 쾌유의 광휘\",[\"쾌유의 광휘 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 쾌유의 광휘\",[\"쾌유의 광휘 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 약화의 낙인\",[\"약화의 낙인 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 약화의 낙인\",[\"약화의 낙인 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 심판의 번개\",[\"심판의 번개 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 심판의 번개\",[\"심판의 번개 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 벼락 난사\",[\"벼락 난사 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 벼락 난사\",[\"벼락 난사 +1\"]]"
  },
  {
    "id": "2026-11-02-active-fixed:[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 충격 해제\",[\"충격 해제 +1\"]]",
    "recordedOn": "2026-11-02",
    "grade": "Legend",
    "power": 100,
    "basis": "fixed",
    "note": "사용자가 확인한 액티브 스킬 노드의 고정 전투력 증가량입니다.",
    "key": "[\"Legend\",\"SkillLevel\",\"스킬 레벨 상승 - 충격 해제\",[\"충격 해제 +1\"]]"
  }
];
