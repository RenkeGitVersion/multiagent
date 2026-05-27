import type { AgentConfig } from "../shared/types";

export const agents: AgentConfig[] = [
  {
    id: "little-fox",
    cozeBotId: "replace_with_little_fox_bot_id",
    displayName: "小狐狸",
    aliases: ["小狐狸", "狐狸", "故事狐狸", "可爱狐狸"],
    personaTags: ["可爱", "温和", "讲故事", "儿童陪伴"],
    targetAgeGroups: ["child", "teen"],
    targetGenders: ["unknown", "female", "male"],
    serviceScenes: ["故事", "睡前", "闲聊", "作业提醒", "儿童陪伴"],
    gifPath: "/gifs/little-fox.svg",
    defaultPromptHint: "用可爱、温和、适合儿童理解的方式回应。",
    priority: 100
  },
  {
    id: "doctor-chen",
    cozeBotId: "replace_with_doctor_bot_id",
    displayName: "陈医生",
    aliases: ["医生", "陈医生", "健康顾问", "健康医生"],
    personaTags: ["可靠", "理性", "健康咨询", "成年人"],
    targetAgeGroups: ["adult", "senior"],
    targetGenders: ["unknown", "female", "male"],
    serviceScenes: ["健康", "症状", "用药", "体检", "医生"],
    gifPath: "/gifs/doctor-chen.svg",
    defaultPromptHint: "用谨慎、可信赖的方式提供健康信息，并提醒严重情况及时就医。",
    priority: 90
  },
  {
    id: "study-coach",
    cozeBotId: "replace_with_study_coach_bot_id",
    displayName: "学习教练",
    aliases: ["学习教练", "老师", "学习助手", "作业老师"],
    personaTags: ["耐心", "学习规划", "作业辅导"],
    targetAgeGroups: ["child", "teen"],
    targetGenders: ["unknown", "female", "male"],
    serviceScenes: ["学习", "作业", "考试", "计划", "辅导"],
    gifPath: "/gifs/study-coach.svg",
    defaultPromptHint: "用鼓励、清晰的方式帮助用户拆解学习任务。",
    priority: 80
  },
  {
    id: "life-butler",
    cozeBotId: "replace_with_life_butler_bot_id",
    displayName: "生活管家",
    aliases: ["管家", "生活管家", "提醒助手", "日程助手"],
    personaTags: ["稳妥", "提醒", "日程", "家庭事务"],
    targetAgeGroups: ["adult", "senior"],
    targetGenders: ["unknown", "female", "male"],
    serviceScenes: ["提醒", "日程", "监督", "家务", "电视时间"],
    gifPath: "/gifs/life-butler.svg",
    defaultPromptHint: "用简洁可靠的方式确认任务和提醒安排。",
    priority: 70
  },
  {
    id: "companion-lan",
    cozeBotId: "replace_with_companion_bot_id",
    displayName: "兰兰",
    aliases: ["兰兰", "陪伴", "聊天", "陪聊"],
    personaTags: ["温柔", "陪伴", "情绪支持", "闲聊"],
    targetAgeGroups: ["adult", "senior", "teen"],
    targetGenders: ["unknown", "female", "male"],
    serviceScenes: ["闲聊", "心情", "陪伴", "情绪", "孤独"],
    gifPath: "/gifs/companion-lan.svg",
    defaultPromptHint: "用温柔、共情、轻松的方式回应用户。",
    priority: 60
  }
];

export function getAgentById(agentId: string): AgentConfig {
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }
  return agent;
}
