import { LLMConfig, UserProfile } from '../types';

export const PRESET_PROMPTS = [
  {
    label: "生命支持急修",
    text: "我是急诊科的王医生，我们抢救室1号床的迈瑞监护仪突然黑屏开不了机，现在病人正在抢救，急需使用！联系电话内线8120。"
  },
  {
    label: "新到DR到货验收",
    text: "放射科门诊1号DR房新买的高压发生器和球管到货了，需要设备科和供应商厂家今天下午3点一起开箱验收。联系人任主任，分机6211。"
  },
  {
    label: "网络故障(转信息科)",
    text: "胃镜室医生电脑网线掉了连不上网，HIS系统闪退，没办法给病人开处方。陈医生，13599992222。"
  },
  {
    label: "强电跳闸(转后勤总务)",
    text: "妇产科门诊2号诊室插座没电，照明灯也一闪一闪的，请派师傅来看下是不是跳闸了。李护士。"
  },
  {
    label: "奥林巴斯漏水(协同厂家)",
    text: "胃镜室电子胃镜CV-290插入管处在漏水测试时发现气密性不合格，可能有微小破损，画面有点模糊。急用！"
  }
];

export const MOCK_VOICE_TEMPLATES = [
  {
    title: "🏥 ICU 输液泵严重故障 (生命应急/特急)",
    text: "我是ICU的李护士，3号病床正在给重症患者输液的贝朗双通道输液泵突然开机报警，错误代码ERROR-201，现在泵已经停掉了，病人情况危急，急需医学装备科老师过来抢救更换和维修！联系内线1205。"
  },
  {
    title: "💨 呼吸内科呼吸机不启动 (生命应急/特急)",
    text: "你好，这里是呼吸内科5病区，我们的一台德尔格Drager呼吸机在做自检时提示氧传感器故障，屏幕一直红灯报错。现在10号床重症急着要换，急需派工程师到5楼呼吸科病房协助抢救！联系人赵医生，分机5610。"
  },
  {
    title: "🔬 儿科血气分析仪故障 (常规报修)",
    text: "医学装备科老师好，我是儿科的小王。我们科室的雅培血气分析仪电池鼓包了，插电源亮红灯就关机，没法做床旁检测了。设备资产号是EQ-91022，我们在住院部3楼东区，麻烦抽空过来，谢谢！"
  },
  {
    title: "🚨 手术室二氧化碳泄露 (气体紧急/高危)",
    text: "紧急报修！我是4号手术室的陈主任。我们这边的医用二氧化碳高压管路接头好像松了，一直发出很大的嘶嘶漏气声音，压力表的指针也掉到底了！手术正在准备中，关系到患者生命安全，请气体组老师马上来4楼手术室查看！联系内线6102。"
  },
  {
    title: "🩺 产科胎心监护仪故障 (科室常见)",
    text: "您好，医学装备科。我是产科门诊的王医生。我们这台GE的胎心监护仪探头好像接触不良，做监护测不出胎心音，波形也是断断续续的。机器型号Corometrics 170，资产号EQ-80120，在门诊2楼204，有空帮我们看下。"
  }
];

export const DEFAULT_LLM_PRESETS: LLMConfig[] = [
  {
    id: 'gemini-default',
    name: 'Google Gemini (官方大模型)',
    website: 'https://ai.google.dev',
    apiKey: '',
    endpoint: '',
    model: 'gemini-3.5-flash',
    contextLimit: 15,
    compressThreshold: 6000,
    isDefault: true
  },
  {
    id: 'openai-default',
    name: 'OpenAI 官方服务 (兼容格式)',
    website: 'https://platform.openai.com',
    apiKey: '',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    contextLimit: 10,
    compressThreshold: 4000,
    isDefault: true
  },
  {
    id: 'deepseek-default',
    name: 'DeepSeek 深度求索',
    website: 'https://platform.deepseek.com',
    apiKey: '',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    contextLimit: 12,
    compressThreshold: 8000,
    isDefault: true
  },
  {
    id: 'ollama-default',
    name: 'Ollama 本地私有化大模型',
    website: 'https://ollama.com',
    apiKey: 'ollama',
    endpoint: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
    contextLimit: 8,
    compressThreshold: 3000,
    isDefault: true
  },
  {
    id: 'offline-default',
    name: '自适应离线机制 (启发式算法)',
    website: 'https://hospital-workstation.local',
    apiKey: 'offline',
    endpoint: 'offline',
    model: 'offline',
    contextLimit: 0,
    compressThreshold: 0,
    isDefault: true
  }
];

export const SIMULATED_USERS: UserProfile[] = [
  {
    id: 'ENG-5021',
    name: '张明华',
    title: '装备科主任工程师',
    dept: '医学装备科',
    department: '医学装备科',
    role: 'engineer',
    avatarText: '张',
    avatarColor: 'bg-indigo-600',
    phone: '内线 8001'
  },
  {
    id: 'ENG-5022',
    name: '李建国',
    title: '资深生物医学工程师',
    dept: '医学装备科',
    department: '医学装备科',
    role: 'engineer',
    avatarText: '李',
    avatarColor: 'bg-blue-600',
    phone: '内线 8002'
  },
  {
    id: 'ENG-5023',
    name: '赵安平',
    title: '临床安全工程师',
    dept: '医学装备科',
    department: '医学装备科',
    role: 'engineer',
    avatarText: '赵',
    avatarColor: 'bg-teal-600',
    phone: '内线 8003'
  },
  {
    id: 'NU-0822',
    name: '王静',
    title: '急诊科主管护师',
    dept: '急诊科',
    department: '急诊科',
    role: 'medical_staff',
    avatarText: '王',
    avatarColor: 'bg-emerald-600',
    phone: '内线 8120'
  },
  {
    id: 'DR-3011',
    name: '赵晓东',
    title: '呼吸内科主治医生',
    dept: '呼吸内科',
    department: '呼吸内科',
    role: 'medical_staff',
    avatarText: '赵',
    avatarColor: 'bg-sky-600',
    phone: '分机 5610'
  },
  {
    id: 'NU-1402',
    name: '陈美兰',
    title: '手术室护士长',
    dept: '手术室',
    department: '手术室',
    role: 'medical_staff',
    avatarText: '陈',
    avatarColor: 'bg-amber-600',
    phone: '内线 6102'
  },
  {
    id: 'NU-8801',
    name: '张丽',
    title: '重症医学科 (ICU) 护士长',
    dept: '重症医学科 (ICU)',
    department: '重症医学科 (ICU)',
    role: 'medical_staff',
    avatarText: '丽',
    avatarColor: 'bg-rose-600',
    phone: '内线 8812'
  },
  {
    id: 'DR-9902',
    name: '王健',
    title: '放射科主管医生',
    dept: '放射科',
    department: '放射科',
    role: 'medical_staff',
    avatarText: '健',
    avatarColor: 'bg-teal-600',
    phone: '内线 8902'
  },
  {
    id: 'DR-9903',
    name: '刘洋',
    title: '超声诊断中心医生',
    dept: '超声科',
    department: '超声科',
    role: 'medical_staff',
    avatarText: '洋',
    avatarColor: 'bg-violet-600',
    phone: '分机 3302'
  },
  {
    id: 'DR-9905',
    name: '赵凯',
    title: '检验科技术主管',
    dept: '检验科',
    department: '检验科',
    role: 'medical_staff',
    avatarText: '凯',
    avatarColor: 'bg-pink-600',
    phone: '分机 4405'
  }
];
