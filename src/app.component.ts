import { Component, signal, ViewChild, ElementRef, inject, effect, computed, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GeminiService } from './services/gemini.service';
import { Chat, Part } from '@google/genai';
import { parse } from 'marked'; // Changed import to specific named export
import pako from 'pako';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

interface Message {
  role: 'user' | 'model';
  text: string;
  images?: string[]; // Changed from single image to array of Base64 data URLs
}

interface ImageAttachment {
  mimeType: string;
  data: string; // Base64 string without header
  url: string;  // Full Data URL for display
}

type AppState = 'initial' | 'consulting' | 'generating' | 'finished';
type ResultTab = 'prd' | 'diagram';
type ViewMode = 'consultant' | 'sdd';
type SddMode = 'comprehensive' | 'simplified' | 'specific' | 'interactive';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styles: [`
    :host { display: block; height: 100%; }
    .loader {
      border: 3px solid #f3f3f3;
      border-radius: 50%;
      border-top: 3px solid #3b82f6;
      width: 20px;
      height: 20px;
      -webkit-animation: spin 1s linear infinite; /* Safari */
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .grab-cursor { cursor: grab; }
    .grabbing-cursor { cursor: grabbing; }
    /* Modal Overlay */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
  `]
})
export class AppComponent {
  private geminiService = inject(GeminiService);
  private sanitizer = inject(DomSanitizer);

  // API Key State
  apiKey = signal('');
  isApiKeySet = signal(false);

  // View State
  currentView = signal<ViewMode>('consultant');
  
  // Target Platform State
  targetPlatform = signal('Python');
  targetOptions = [
    'VBA',
    'Python',
    'Pure Frontend (AI Studio)'
  ];

  // --- Consultant State ---
  state = signal<AppState>('initial');
  activeTab = signal<ResultTab>('prd');
  generationStatus = signal<string>(''); // For progress indication
  isCopied = signal(false); // Feedback state for copy button
  
  // Chat
  messages = signal<Message[]>([]);
  userInput = signal('');
  
  // Changed to support multiple images
  selectedImages = signal<ImageAttachment[]>([]); 
  
  isChatLoading = signal(false);
  chatInstance: Chat | null = null;
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;
  @ViewChild('chatInput') private chatInput!: ElementRef<HTMLTextAreaElement>;

  // Results
  prdContent = signal('');
  plantUmlCode = signal('');

  // Diagram Zoom/Pan State
  zoomLevel = signal(1);
  pan = signal({x: 0, y: 0});
  isDragging = false;
  lastMousePosition = {x: 0, y: 0};

  // --- SDD Generator State ---
  sddInput = signal('');
  sddMode = signal<SddMode>('simplified'); // Default to simplified
  sddResult = signal(''); // Stores result for file generation or preview
  isSddGenerating = signal(false);
  isSddCopied = signal(false);
  
  // SDD Chat State (Unified for all modes)
  sddChatInstance: Chat | null = null;
  sddMessages = signal<Message[]>([]);
  sddReplyInput = signal('');
  @ViewChild('sddScrollContainer') private sddScrollContainer!: ElementRef;
  @ViewChild('sddInput') private sddInputRef!: ElementRef<HTMLTextAreaElement>;


  // Computed: Render Markdown to HTML for PRD
  prdHtml = computed((): SafeHtml => {
    const raw = this.prdContent();
    if (!raw) return '';
    return this.renderMarkdown(raw);
  });
  
  // Computed: Render SDD Result (for download/preview)
  sddHtml = computed((): SafeHtml => {
    const raw = this.sddResult();
    if (!raw) return '';
    return this.renderMarkdown(raw);
  });

  // Computed diagram URL using Kroki with proper Deflate compression
  diagramUrl = computed(() => {
    const code = this.plantUmlCode();
    if (!code) return '';
    try {
      // Kroki requires Deflate compression (zlib)
      const data = new TextEncoder().encode(code);
      const compressed = pako.deflate(data, { level: 9 });
      
      // Convert Uint8Array to binary string efficiently
      // We process in chunks if necessary, but for diagram source 
      // a simple loop is usually fine for < 100kb
      let binary = '';
      const len = compressed.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(compressed[i]);
      }
      
      const b64 = btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
        
      return `https://kroki.io/plantuml/svg/${b64}`;
    } catch (e) {
      console.error('Kroki encoding error', e);
      return '';
    }
  });

  constructor() {
    // Auto scroll chat
    effect(() => {
      const msgs = this.messages();
      setTimeout(() => {
        if (this.scrollContainer) {
          this.scrollContainer.nativeElement.scrollTop = this.scrollContainer.nativeElement.scrollHeight;
        }
      }, 50);
    });

    // Auto scroll SDD chat
    effect(() => {
        const msgs = this.sddMessages();
        setTimeout(() => {
          if (this.sddScrollContainer) {
            this.sddScrollContainer.nativeElement.scrollTop = this.sddScrollContainer.nativeElement.scrollHeight;
          }
        }, 50);
      });
  }

  // --- API Key Handling ---
  submitApiKey() {
    if (this.apiKey().trim()) {
      this.geminiService.setApiKey(this.apiKey().trim());
      this.isApiKeySet.set(true);
    }
  }

  @HostListener('window:beforeunload')
  clearApiKey() {
    // This is technically redundant as memory is cleared on reload,
    // but ensures we don't persist anything if we were using storage.
    this.apiKey.set('');
    this.isApiKeySet.set(false);
  }

  // --- View Switching ---
  switchView(view: ViewMode) {
    this.currentView.set(view);
  }

  // --- Chat Functionality ---

  async startConsultation() {
    if (!this.userInput().trim() && this.selectedImages().length === 0) return;
    
    const initialIdea = this.userInput();
    const images = this.selectedImages(); // Get current images

    this.state.set('consulting');
    
    // Add user message to UI immediately
    this.messages.update(m => [...m, { 
      role: 'user', 
      text: initialIdea,
      images: images.map(img => img.url)
    }]);

    this.userInput.set('');
    this.selectedImages.set([]); // Clear images
    this.resetInputHeight();
    this.isChatLoading.set(true);

    this.chatInstance = this.geminiService.createChat();
    
    try {
      let response;
      if (images.length > 0) {
        // Send initial message with images
        const parts: Part[] = [];
        if (initialIdea) parts.push({ text: initialIdea });
        else parts.push({ text: '請分析這些圖片' });

        images.forEach(img => {
          parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        });

        response = await this.chatInstance.sendMessage({ message: parts });
      } else {
        response = await this.chatInstance.sendMessage({ message: initialIdea });
      }

      this.messages.update(m => [...m, { role: 'model', text: response.text || '' }]);
    } catch (err) {
      console.error(err);
      this.messages.update(m => [...m, { role: 'model', text: '發生錯誤，請稍後再試。' }]);
    } finally {
      this.isChatLoading.set(false);
    }
  }

  async sendMessage() {
    if ((!this.userInput().trim() && this.selectedImages().length === 0) || !this.chatInstance) return;

    const text = this.userInput();
    const images = this.selectedImages();

    // Update UI
    this.messages.update(m => [...m, { 
      role: 'user', 
      text: text,
      images: images.map(img => img.url)
    }]);

    this.userInput.set('');
    this.selectedImages.set([]);
    this.resetInputHeight();
    this.isChatLoading.set(true);

    try {
      let response;
      if (images.length > 0) {
        // Construct parts for images + text
        const parts: Part[] = [];
        if (text) parts.push({ text });
        
        images.forEach(img => {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        });
        
        response = await this.chatInstance.sendMessage({ message: parts });
      } else {
        response = await this.chatInstance.sendMessage({ message: text });
      }
      
      this.messages.update(m => [...m, { role: 'model', text: response.text || '' }]);
    } catch (err) {
      console.error(err);
      this.messages.update(m => [...m, { role: 'model', text: '連線錯誤。' }]);
    } finally {
      this.isChatLoading.set(false);
    }
  }

  // Helper to render markdown in chat
  renderMarkdown(text: string): SafeHtml {
    try {
      // Robustly handle marked parsing
      // Ensure async is false to get a string immediately
      const result = parse(text, { async: false });
      
      if (typeof result === 'string') {
        return this.sanitizer.bypassSecurityTrustHtml(result);
      }
      
      // Fallback if marked returns a Promise (unexpected with async: false but possible in some envs)
      console.warn('Marked returned a non-string value:', result);
      return this.sanitizer.bypassSecurityTrustHtml(text);
      
    } catch (e) {
      console.error('Chat markdown error', e);
      // Fallback to plain text if parsing fails entirely
      return this.sanitizer.bypassSecurityTrustHtml(text);
    }
  }

  // --- Input Handling ---

  onInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  resetInputHeight() {
    if (this.chatInput) {
      this.chatInput.nativeElement.style.height = 'auto';
    }
  }

  handleEnter(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !this.isChatLoading() && this.state() !== 'generating') {
      event.preventDefault();
      if (this.state() === 'initial') {
        this.startConsultation();
      } else {
        this.sendMessage();
      }
    }
  }

  // --- Image Upload Handling ---

  onImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.processFiles(input.files);
      // Clear input so same file can be selected again
      input.value = '';
    }
  }

  handlePaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      event.preventDefault(); // Stop image being pasted as text/garbage
      // Convert Array<File> to FileList-like object or just process array
      this.processFileArray(files);
    }
  }

  private processFiles(fileList: FileList) {
    const files: File[] = Array.from(fileList);
    this.processFileArray(files);
  }

  private processFileArray(files: File[]) {
    files.forEach(file => {
        if (!file.type.startsWith('image/')) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const url = e.target?.result as string;
            const base64Data = url.split(',')[1];
            
            this.selectedImages.update(current => [...current, {
                mimeType: file.type,
                data: base64Data,
                url: url
            }]);
        };
        reader.readAsDataURL(file);
    });
  }

  removeImage(index: number) {
    this.selectedImages.update(images => images.filter((_, i) => i !== index));
  }

  // --- Generation Logic ---

  async finishAndGenerate() {
    this.state.set('generating');
    
    // Compile history
    const history = this.messages().map(m => {
      let content = `${m.role === 'user' ? 'User' : 'Consultant'}: ${m.text}`;
      if (m.images && m.images.length > 0) {
        content += `\n[User uploaded ${m.images.length} image(s)]`;
      }
      return content;
    }).join('\n\n');

    try {
      // Sequential generation to provide clear progress updates
      
      this.generationStatus.set('正在分析對話紀錄...');
      // Small delay to let UI update
      await new Promise(r => setTimeout(r, 800));

      this.generationStatus.set('步驟 1/2: 正在撰寫產品需求文件 (PRD)...');
      const prd = await this.geminiService.generatePRD(history, this.targetPlatform());
      this.prdContent.set(prd);

      this.generationStatus.set('步驟 2/2: 正在繪製系統架構圖 (PlantUML)...');
      const diagram = await this.geminiService.generatePlantUML(history, this.targetPlatform());
      this.plantUmlCode.set(diagram);
      
      this.generationStatus.set('完成！正在準備預覽...');
      await new Promise(r => setTimeout(r, 500));

      this.state.set('finished');
    } catch (e) {
      console.error(e);
      this.state.set('consulting'); // Revert on error
      alert('生成失敗，請重試');
    }
  }

  // --- Utilities ---

  downloadPrd() {
    this.downloadText(this.prdContent(), 'PRD.md');
  }

  async copyPrd() {
    this.copyToClipboard(this.prdContent(), this.isCopied);
  }

  async downloadDiagram() {
    const svgUrl = this.diagramUrl();
    if (!svgUrl) return;
    
    // Replace /svg/ with /png/ for the download URL
    const pngUrl = svgUrl.replace('/svg/', '/png/');

    try {
      // We must fetch it as a blob to trigger a proper download from the browser
      // because strictly linking to a cross-origin image often just opens it.
      const resp = await fetch(pngUrl);
      const blob = await resp.blob();
      const dlUrl = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = 'architecture.png';
      a.click();
      
      URL.revokeObjectURL(dlUrl);
    } catch (e) {
      console.error(e);
      // Fallback: Just open the link if fetch fails (e.g. strict CORS, though Kroki is usually open)
      window.open(pngUrl, '_blank');
    }
  }

  reset() {
    this.state.set('initial');
    this.messages.set([]);
    this.prdContent.set('');
    this.plantUmlCode.set('');
    this.chatInstance = null;
    this.selectedImages.set([]);
    this.resetZoom();
  }

  // --- Zoom / Pan Logic ---

  zoomIn() {
    this.zoomLevel.update(z => Math.min(z * 1.2, 5));
  }

  zoomOut() {
    this.zoomLevel.update(z => Math.max(z / 1.2, 0.1));
  }

  resetZoom() {
    this.zoomLevel.set(1);
    this.pan.set({x: 0, y: 0});
  }

  onWheel(event: WheelEvent) {
    if (this.activeTab() !== 'diagram') return;
    event.preventDefault();
    if (event.deltaY < 0) {
      this.zoomIn();
    } else {
      this.zoomOut();
    }
  }

  startDrag(event: MouseEvent) {
    if (this.activeTab() !== 'diagram') return;
    this.isDragging = true;
    this.lastMousePosition = { x: event.clientX, y: event.clientY };
  }

  onDrag(event: MouseEvent) {
    if (!this.isDragging || this.activeTab() !== 'diagram') return;
    event.preventDefault();
    const dx = event.clientX - this.lastMousePosition.x;
    const dy = event.clientY - this.lastMousePosition.y;
    this.pan.update(p => ({ x: p.x + dx, y: p.y + dy }));
    this.lastMousePosition = { x: event.clientX, y: event.clientY };
  }

  endDrag() {
    this.isDragging = false;
  }

  // --- SDD Logic ---

  onSddFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        this.sddInput.set(content);
        // Clear value so same file can be selected again if needed
        input.value = '';
      };
      reader.readAsText(file);
    }
  }

  async generateSdd() {
    if (!this.sddInput().trim()) return;
    this.isSddGenerating.set(true);

    // Reset Chat State
    this.sddMessages.set([]);
    this.sddChatInstance = this.geminiService.createSddChat();

    // Get the initial prompt based on the selected mode
    const prompt = this.geminiService.getSddInitialPrompt(this.sddInput(), this.sddMode());

    try {
        const response = await this.sddChatInstance.sendMessage({ message: prompt });
        const text = response.text || '';
        this.sddMessages.update(m => [...m, { role: 'model', text: text }]);
        
        // Update sddResult with the latest content for download/copy
        // For comprehensive/simplified, this is the document.
        // For specific/interactive, this is just the first step.
        this.sddResult.set(this.geminiService.cleanMarkdown(text));

    } catch (e) {
        console.error(e);
        alert('對話啟動失敗');
    } finally {
        this.isSddGenerating.set(false);
    }
  }
  
  // --- SDD Chat Input Handling ---
  
  onSddInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
  }

  resetSddInputHeight() {
    if (this.sddInputRef) {
      this.sddInputRef.nativeElement.style.height = 'auto';
    }
  }

  handleSddEnter(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !this.isSddGenerating()) {
      event.preventDefault();
      this.sendSddReply();
    }
  }

  async sendSddReply() {
    if (!this.sddReplyInput().trim() || !this.sddChatInstance) return;
    
    const text = this.sddReplyInput();
    this.sddReplyInput.set('');
    this.resetSddInputHeight(); // Reset height immediately
    this.sddMessages.update(m => [...m, { role: 'user', text }]);
    this.isSddGenerating.set(true);

    try {
        const response = await this.sddChatInstance.sendMessage({ message: text });
        const respText = response.text || '';
        this.sddMessages.update(m => [...m, { role: 'model', text: respText }]);
        
        // Always update the downloadable result with the latest AI response
        this.sddResult.set(this.geminiService.cleanMarkdown(respText));

    } catch (e) {
        console.error(e);
        this.sddMessages.update(m => [...m, { role: 'model', text: '連線錯誤，請重試。' }]);
    } finally {
        this.isSddGenerating.set(false);
    }
  }

  downloadSdd() {
    this.downloadText(this.sddResult(), 'SDD.md');
  }

  async copySdd() {
    this.copyToClipboard(this.sddResult(), this.isSddCopied);
  }

  // Common Helpers
  private downloadText(content: string, filename: string) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async copyToClipboard(content: string, signalToUpdate: any) {
    try {
      await navigator.clipboard.writeText(content);
      signalToUpdate.set(true);
      setTimeout(() => signalToUpdate.set(false), 2000);
    } catch (err) {
      console.error('Failed to copy: ', err);
      alert('複製失敗，請手動複製');
    }
  }
}