import { Injectable } from '@angular/core';
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';

@Injectable({
  providedIn: 'root'
})
export class GeminiService {
  private ai!: GoogleGenAI;
  private model = 'gemini-2.5-flash';

  // System instructions from the user prompt
  private readonly CONSULTANT_INSTRUCTION = `
您是一位經驗豐富的專案顧問，您的任務是根據使用者提供的初始專案構想，透過多輪對話來收集更多詳細資訊並釐清任何模糊之處。您的最終目標是為一個最小可行產品 (MVP) 定義其範圍。在整個對話過程中，請確保您的回應結構良好，易於閱讀，並且所有回應都必須使用繁體中文。

# Step by Step instructions
1. Acknowledge the user's Project Idea and state your role as a project consultant in Traditional Chinese.
2. Ask a clarifying question about the Project Idea in Traditional Chinese, focusing on understanding its core purpose or target audience.
3. Evaluate the user's response. If the MVP scope is not yet clearly defined or if there are still ambiguities, go back to step 2 and ask another clarifying question, making progress towards defining the MVP scope. Otherwise, proceed to step 4.
4. Summarize the clarified Project Idea and proposed MVP scope in a well-structured format in Traditional Chinese.
`;

  // System instructions for the SDD Architect
  private readonly ARCHITECT_INSTRUCTION = `
您是一位資深軟體架構師與技術顧問。您的目標是協助使用者根據 PRD 生成高品質的軟體設計文件 (SDD)。

**核心原則 (針對 Gemini CLI 開發優化)**：
1. **目標受眾**：此 SDD 的讀者是 **AI Coding Agent (如 Gemini CLI)**。內容必須邏輯清晰、步驟明確，方便 AI 能夠依序讀取並生成程式碼。
2. **專案屬性**：預設為**公司內部工具**或**單機應用**。
3. **排除項目**：除非使用者特別要求，否則**嚴禁**包含容器化 (Docker)、K8s、CI/CD 或複雜的雲端部署章節。
4. **必要章節**：所有 SDD 結尾必須包含 **「實作路徑 (Implementation Roadmap)」**，詳細列出檔案建立順序與開發步驟。

**回應規則**：
1. 使用繁體中文回答。
2. 確保 Markdown 格式正確，便於渲染。
3. 保持開放態度，隨時準備根據使用者的回饋調整架構或細節。
`;

  constructor() {
    // AI instance will be initialized via setApiKey
  }

  setApiKey(key: string) {
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  private ensureInitialized() {
    if (!this.ai) {
      throw new Error('API Key not set. Please provide a valid Gemini API Key.');
    }
  }

  // --- Chat Functionality ---

  createChat() {
    this.ensureInitialized();
    return this.ai.chats.create({
      model: this.model,
      config: {
        systemInstruction: this.CONSULTANT_INSTRUCTION,
        temperature: 0.7,
      }
    });
  }

  createSddChat() {
    this.ensureInitialized();
    return this.ai.chats.create({
      model: this.model,
      config: {
        systemInstruction: this.ARCHITECT_INSTRUCTION,
        temperature: 0.5, // Lower temperature for more consistent technical output
      }
    });
  }

  // --- PRD Generation ---

  async generatePRD(conversationHistory: string, targetPlatform: string): Promise<string> {
    this.ensureInitialized();
    const prompt = `
You are a meticulous technical writer specializing in product documentation and an expert in Traditional Chinese. Your task is to generate a comprehensive Product Requirement Document (PRD) based on the provided project consultation details. The PRD must be formatted in Markdown and encoded in UTF-8 to ensure all Traditional Chinese characters are displayed correctly.

Target Platform/Technology Stack: ${targetPlatform}

# Step by Step instructions
1. Carefully review the Project Consultation For Mvp to understand all clarified project details and the defined scope for the Minimum Viable Product (MVP).
2. Begin writing the Product Requirement Document (PRD) in Markdown format, starting with a clear title in Traditional Chinese.
3. For each section of the PRD (e.g., Introduction, Features, User Stories, Technical Requirements, etc.), write the content in Traditional Chinese, ensuring it directly reflects the Project Consultation For Mvp.
4. Specifically for the "Technical Requirements" section, ensure the recommendations align with the "${targetPlatform}" platform.
5. After completing a section, review it to ensure it is clear, comprehensive, and accurately translated into Traditional Chinese.
6. Continue writing and reviewing sections until the entire PRD is complete, adhering to the Markdown format and ensuring all content is in Traditional Chinese and UTF-8 encoded.

Project Consultation For Mvp:
"""
${conversationHistory}
"""
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt
    });

    return this.cleanMarkdown(response.text || '# Error Generating PRD');
  }

  // --- Diagram Generation ---

  async generatePlantUML(conversationHistory: string, targetPlatform: string): Promise<string> {
    this.ensureInitialized();
    const prompt = `
You are an expert in system architecture and PlantUML. Your goal is to generate VALID, SYNTACTICALLY CORRECT PlantUML code for a system based on the "${targetPlatform}" platform.

# Rules
1. Analyze the Project Consultation below.
2. Generate a System Architecture Diagram (Component Diagram) or Sequence Diagram that fits the "${targetPlatform}" architecture.
3. **STRICTLY FORBIDDEN**: Do NOT use \`!include\` or external libraries (like C4-PlantUML/stdlib) as they often cause rendering errors (404/400). Use standard PlantUML elements only (package, node, component, database, actor, interface).
4. Use \`!theme plain\` for a professional, clean look. **DO NOT** use \`skinparam handwritten\` (it causes syntax warnings).
5. Do NOT use non-standard characters in *identifiers* (variable names). You CAN use Traditional Chinese in *labels* (strings inside [] or "").
6. Keep the diagram concise.
7. Output ONLY the PlantUML code.

Project Consultation:
"""
${conversationHistory}
"""

Response Format:
@startuml
... code ...
@enduml
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt
    });

    const text = response.text || '';
    const match = text.match(/@startuml([\s\S]*?)@enduml/);
    if (match) {
      return `@startuml${match[1]}@enduml`;
    }
    // Fallback cleanup if strict tags aren't perfect
    return text.replace(/^```plantuml\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  }

  // --- SDD Generation Prompts ---
  
  /**
   * Returns the initial prompt string for the SDD chat based on the selected mode.
   * Now all modes are handled via chat to support follow-up interactions.
   */
  getSddInitialPrompt(prdContent: string, mode: 'comprehensive' | 'simplified' | 'specific' | 'interactive'): string {
    const prdSection = `
## 輸入的 PRD 內容
"""
${prdContent}
"""
`;

    switch (mode) {
      case 'comprehensive':
        return `
${prdSection}

請根據上述 PRD，直接生成一份**完整的 SDD（軟體設計文檔）**。

## 專案背景：
此專案為**公司內部工具**，將由 **Gemini CLI (AI Agent)** 讀取此文件並協助撰寫程式碼。

## 要求章節：
1. **系統架構設計**：
   - 請根據 PRD 需求選擇**最適合的技術棧**（前端框架、後端語言、資料庫）。
   - **請勿**受限於輕量級框架，若系統複雜，請採用正規企業級架構（例如：Angular/React + Node/Java/C# + PostgreSQL/MySQL 等）。
   - 請明確定義資料庫選擇（可使用需安裝的資料庫，如 Postgres，只要能在本機運行即可）。
2. **數據模型設計**：ER 圖描述、資料表結構（Table Schema）。
3. **API 設計規範**：主要 RESTful API 端點、請求/響應範例。
4. **前端架構設計**：組件結構、狀態管理、路由規劃。
5. **核心模組設計**：核心功能的類別或介面定義。
6. **安全與配置**：認證機制、環境變數 (.env) 管理。
7. **實作路徑 (Implementation Roadmap)** (關鍵)：
   - 請按順序條列開發步驟，供 AI Agent 執行（例如：1. 初始化專案, 2. 設定資料庫, 3. 實作 API, 4. 前端開發...）。

**注意**：
- **不需要** Docker、K8s 或雲端部署章節。
- 請著重於**本機開發環境 (Localhost)** 的設置與執行指南。
- 請使用 Markdown 格式輸出。
`;
      
      case 'simplified':
        return `
${prdSection}

請根據上述 PRD，直接生成一份**精簡版 SDD**。此模式專為**初學者**與**快速驗證**設計，且特別針對 **AI 輔助開發 (如 Gemini CLI)** 進行優化。

## 技術選型指引 (強制)：
1. **核心原則**：不使用容器化 (Docker)、不需複雜雲端部署。目標是在本機 (Localhost) 直接運行。
2. **介面要求**：**必須包含圖形化使用者介面 (Web UI)**。除非 PRD 明確要求，否則**嚴禁**設計為純 CLI (Command Line Interface) 工具。
3. **後端/全棧**：強烈推薦 **Python** 生態系 (建議使用 **Streamlit** 快速建構 UI，或 **FastAPI/Flask** 搭配 **HTML Templates**)。
4. **資料庫**：使用 **SQLite** (單一檔案資料庫)，無需安裝伺服器軟體。

## SDD 內容要求 (請確保 Markdown 結構清晰)：
1. **新手友善的架構詳解**：
   - 用淺顯易懂的方式解釋系統運作流程（前端 UI -> API -> Logic -> SQLite）。
2. **核心模組列表**：列出最關鍵的功能模組。
3. **簡易資料庫設計**：列出資料表與關鍵欄位。
4. **API 與頁面規劃**：列出核心 API 端點與前端頁面結構。
5. **AI 協作實作路徑 (Implementation Roadmap)** (重要)：
   - 這是為了讓 Gemini CLI 或其他 AI Coding Agent 能依序執行開發。
   - 請按順序條列具體步驟：
     1. 環境建置 (venv, requirements.txt)。
     2. 資料庫初始化 (models.py, init_db.py)。
     3. 後端與前端開發 (app.py 或 main.py + templates)。
     4. 整合測試。

請使用 Markdown 格式輸出。
`;

      case 'specific':
        return `
${prdSection}

我需要你為這個專案推薦適合的技術棧，並生成 SDD。

## 專案背景：
此專案為**內部工具**，將由 **AI Agent** 協助開發。

## 步驟 1：技術棧推薦與確認
請先不要生成完整的 SDD。請先分析 PRD 的需求規模與複雜度，然後：
1. **推薦一組技術棧**：
   - 請優先考慮**本機開發友善 (Localhost-friendly)** 的方案。
   - **不需強制輕量化**：若專案適合，可推薦企業級技術棧（如 Java Spring Boot, .NET Core, Angular, React 等）。
   - **排除** 容器化 (Docker/K8s) 相關技術。
2. **評估開發難度**（簡單/中等/困難）並說明理由。
3. **詢問我是否接受此技術棧**。

待我確認技術棧後，請在下一次回應中生成詳細 SDD，並務必包含 **「實作路徑 (Implementation Roadmap)」** 章節。
`;

      case 'interactive':
        return `
${prdSection}

我想要生成 SDD，但我希望透過**漸進式詢問**的方式來決定技術細節。

## 專案背景：
此專案為**內部工具**，不需考慮 Docker 或複雜雲端部署。最終產出的 SDD 必須包含供 AI Agent 執行的 **「實作路徑」**。

## 請按以下步驟進行：

### 第 1 步：PRD 分析
請先分析 PRD 並列出：
1. 核心功能列表（5-10 個）。
2. 技術複雜度評估。
3. 需要做哪些關鍵技術決策（例如：前端要用 Web 還是 CLI？資料庫要用 SQL 還是 NoSQL？）。

請先執行第 1 步，並在結尾準備進入第 2 步的決策詢問。
`;
    }
    
    return '';
  }


  // Helper to clean markdown blocks
  public cleanMarkdown(text: string): string {
    const codeBlockMatch = text.match(/^\s*```(?:markdown)?\s*([\s\S]*?)\s*```\s*$/i);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    } 
    text = text.replace(/^\s*```(?:markdown)?\s*/i, '');
    text = text.replace(/\s*```\s*$/, '');
    return text.trim();
  }
}