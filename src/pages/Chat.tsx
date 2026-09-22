// Chat.tsx - Página PÚBLICA de chat para clientes finais
// Suporta vitrine com slug + tenant_id

import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Send, MessageCircle, Loader2, ArrowLeft, ShoppingBag, Trash2, Mic, Square, X, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MarkdownMessage } from '@/components/MarkdownMessage';
import { useApp } from '@/contexts/AppContext';
import { useConversation } from '@/hooks/useConversation';
import { useBusinessConfig } from '@/hooks/useBusinessConfig';
import { supabase } from '@/integrations/supabase/client';
import { usePWABlocker } from '@/hooks/usePWABlocker';
import { toast } from 'sonner';
import { ProductGalleryViewer, ProductGalleryPreview } from '@/components/ProductGalleryViewer';
import { CatalogCards } from '@/components/chat/CatalogCards';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { SpeakButton, playMessageSpeech, stopMessageSpeech, cleanTextForSpeech } from '@/components/chat/SpeakButton';

// Chave estável da preferência de áudio automático (padrão: ativado)
const AUTO_SPEAK_KEY = 'ania_auto_speak_enabled';


const CATALOG_MARKER = '__CATALOG__';
const CATALOG_REGEX = /\b(catálogo|catalogo|produtos?|opções|opcoes|cardápio|cardapio|o que (vocês|voces|tu) (vende|tem|oferec|têm|tens)|me mostra|quero ver|mostrar (os )?produtos|lista de produtos|disponíveis|disponiveis|o que tem (para|pra) vender)\b/i;


interface SupabaseProduct {
  id: string;
  name: string;
  price: number;
  category: string | null;
  short_description: string | null;
  long_description: string | null;
  min_price_allowed: number | null;
  payment_methods: string[] | null;
  delivery_info: string | null;
  image_url: string | null;
  payment_link: string | null;
  active: boolean;
  tenant_id: string | null;
  has_gallery: boolean;
}

interface StorefrontData {
  tenant_id: string;
  slug: string;
}

export default function Chat() {
  // Block PWA install prompts on this public route
  usePWABlocker();
  
  const { productId, slug } = useParams<{ productId?: string; slug?: string }>();
  const { business } = useApp();
  const [storefront, setStorefront] = useState<StorefrontData | null>(null);
  const { config } = useBusinessConfig(storefront?.tenant_id ?? (slug ? null : undefined));
  
  const {
    conversationId,
    messages,
    negotiation,
    closing,
    loading: conversationLoading,
    lastBotResponse,
    addMessage,
    updateNegotiation,
    updateClosing,
    clearConversation
  } = useConversation(productId, false);
  
  const [isClearing, setIsClearing] = useState(false);
  
  const [supabaseProducts, setSupabaseProducts] = useState<SupabaseProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks which conversationId has already been initialized (welcome + catalog inserted).
  // Using a ref + per-conversation key prevents duplicate inserts caused by
  // re-renders, async timing of addMessage, or multiple effect runs after clearing.
  const initializedConvRef = useRef<string | null>(null);
  const isInitializingRef = useRef(false);

  // Áudio automático da última resposta da ANIA (padrão: ativado; preferência persistida)
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(AUTO_SPEAK_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  // ID da última mensagem de bot que já recebeu reprodução automática (anti-duplicidade)
  const lastAutoSpokenMessageIdRef = useRef<string | null>(null);

  const handleToggleAutoSpeak = () => {
    setAutoSpeakEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTO_SPEAK_KEY, String(next));
      } catch {
        // localStorage indisponível — mantém apenas em memória
      }
      if (!next) stopMessageSpeech();
      return next;
    });
  };

  // Reproduz automaticamente APENAS a última mensagem válida do bot,
  // uma única vez por mensagem. Ignora catálogo e textos vazios após limpeza.
  useEffect(() => {
    if (!autoSpeakEnabled) return;

    const lastBotMessage = [...messages]
      .reverse()
      .find((m) => m.sender === 'bot' && m.content !== CATALOG_MARKER);

    if (!lastBotMessage) return;
    if (lastAutoSpokenMessageIdRef.current === lastBotMessage.id) return;
    if (!cleanTextForSpeech(lastBotMessage.content)) return;

    // Marca ANTES de falar para que re-renderizações não disparem de novo
    lastAutoSpokenMessageIdRef.current = lastBotMessage.id;
    void playMessageSpeech(lastBotMessage.id, lastBotMessage.content, {
      voice: config?.assistant_voice,
      instructions: config?.assistant_voice_style,
      speed: config?.assistant_voice_speed,
    });
  }, [messages, autoSpeakEnabled, config?.assistant_voice, config?.assistant_voice_style, config?.assistant_voice_speed]);

  // Gravação de voz -> transcrição preenche o campo de texto (usuário revisa e envia)
  const voice = useVoiceRecorder({
    onTranscript: (text) => {
      setInputValue((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
      inputRef.current?.focus();
    },
    onError: (message) => toast.error(message),
  });
  const formatTimer = (total: number) =>
    `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

  const [tenantConfig, setTenantConfig] = useState<{ business_name?: string; business_category?: string } | null>(null);
  
  // Gallery state
  const [galleryImages, setGalleryImages] = useState<string[]>([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryInitialIndex, setGalleryInitialIndex] = useState(0);

  // Buscar produtos do Supabase com suporte a tenant
  useEffect(() => {
    const fetchProducts = async () => {
      try {
        let tenantId: string | null = null;

        // Se tem slug, buscar o tenant_id pelo storefront
        if (slug) {
          const { data: sfData } = await supabase
            .from('storefronts')
            .select('tenant_id, slug')
            .eq('slug', slug)
            .eq('is_active', true)
            .single();
          
          if (sfData) {
            setStorefront(sfData);
            tenantId = sfData.tenant_id;

            // Buscar config do tenant
            const { data: configData } = await supabase
              .from('business_config')
              .select('business_name, business_category')
              .eq('tenant_id', tenantId)
              .single();
            
            if (configData) {
              setTenantConfig(configData);
            }
          }
        }

        // Buscar produtos
        let query = supabase
          .from('products')
          .select('*')
          .eq('active', true)
          .order('created_at', { ascending: false });
        
        if (tenantId) {
          query = query.eq('tenant_id', tenantId);
        }

        const { data } = await query;
        setSupabaseProducts(data || []);
      } finally {
        setLoadingProducts(false);
      }
    };
    fetchProducts();
  }, [slug]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const contextProduct = productId 
    ? supabaseProducts.find(p => p.id === productId)
    : null;

  // Buscar imagens da galeria quando o produto tem galeria
  useEffect(() => {
    const fetchGalleryImages = async () => {
      if (!contextProduct?.has_gallery || !productId) {
        setGalleryImages([]);
        return;
      }

      const { data } = await supabase
        .from('product_images')
        .select('image_url')
        .eq('product_id', productId)
        .order('display_order', { ascending: true });

      setGalleryImages(data?.map(img => img.image_url) || []);
    };

    fetchGalleryImages();
  }, [contextProduct?.has_gallery, productId]);

  // Handler para abrir galeria
  const handleOpenGallery = (index: number) => {
    setGalleryInitialIndex(index);
    setGalleryOpen(true);
  };

  // Gerar mensagem de boas-vindas baseada no contexto
  const getWelcomeMessage = useCallback((isNewSession: boolean = false) => {
    if (contextProduct) {
      const price = Number(contextProduct.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      if (isNewSession) {
        return `✨ **Novo atendimento iniciado!**\n\nOlá! 👋 Agora estou focada em te ajudar com o **${contextProduct.name}**! O valor é ${price}. Em que posso ajudar?`;
      }
      return `Olá! 👋 Você está interessado no **${contextProduct.name}**! O valor é ${price}. Posso te ajudar?`;
    } else if (supabaseProducts.length > 0) {
      if (isNewSession) {
        return `✨ **Novo atendimento iniciado!**\n\nOlá! 👋 Bem-vindo${business.nome ? ` à ${business.nome}` : ''}! Temos ${supabaseProducts.length} produto(s) disponíveis. Como posso ajudar?`;
      }
      return `Olá! 👋 Bem-vindo${business.nome ? ` à ${business.nome}` : ''}! Temos ${supabaseProducts.length} produto(s). Como posso ajudar?`;
    }
    return isNewSession 
      ? `✨ **Novo atendimento iniciado!**\n\nOlá! 👋 Como posso te ajudar hoje?`
      : `Olá! 👋 Como posso te ajudar hoje?`;
  }, [contextProduct, supabaseProducts, business.nome]);

  // Mensagem inicial — protegida contra duplicidade via ref por conversationId
  useEffect(() => {
    if (conversationLoading || loadingProducts) return;
    if (!conversationId) return;
    if (initializedConvRef.current === conversationId) return;
    if (isInitializingRef.current) return;

    // Se já existem mensagens nessa conversa, apenas marca como inicializada.
    if (messages.length > 0) {
      initializedConvRef.current = conversationId;
      return;
    }

    isInitializingRef.current = true;
    const convAtStart = conversationId;
    (async () => {
      try {
        await addMessage(getWelcomeMessage(false), 'bot', 'Boas-vindas');
        if (!contextProduct && supabaseProducts.length > 0) {
          await addMessage(CATALOG_MARKER, 'bot', 'Catálogo');
        }
        initializedConvRef.current = convAtStart;
      } finally {
        isInitializingRef.current = false;
      }
    })();
  }, [conversationId, conversationLoading, loadingProducts, messages.length, getWelcomeMessage, addMessage, contextProduct, supabaseProducts.length]);

  // Handler para limpar conversa e iniciar novo atendimento.
  // A inserção da boas-vindas + catálogo é feita pelo useEffect acima
  // assim que o novo conversationId for emitido — evita duplicação.
  const handleClearConversation = async () => {
    if (isClearing) return;

    setIsClearing(true);
    try {
      // Interrompe qualquer áudio em reprodução e reseta o controle de auto-fala,
      // permitindo que a nova mensagem de boas-vindas seja tratada como nova resposta
      stopMessageSpeech();
      lastAutoSpokenMessageIdRef.current = null;
      // Invalida o guard atual para permitir nova inicialização
      initializedConvRef.current = null;
      await clearConversation();
      toast.success('Novo atendimento iniciado!');
    } catch (err) {
      console.error('[Chat] Error clearing conversation:', err);
      toast.error('Erro ao iniciar novo atendimento');
    } finally {
      setIsClearing(false);
    }
  };

  const handleSend = async () => {
    const trimmedInput = inputValue.trim();
    if (!trimmedInput || isTyping) return;

    setInputValue('');
    setIsTyping(true);
    await addMessage(trimmedInput, 'user');

    // Vitrine mode: intercept catalog questions and reply with cards (no AI call needed)
    if (!contextProduct && CATALOG_REGEX.test(trimmedInput) && supabaseProducts.length > 0) {
      const intro = supabaseProducts.length === 1
        ? 'Temos atualmente este produto disponível. Toque abaixo para ver os detalhes 👇'
        : `Veja os ${supabaseProducts.length} produtos disponíveis. Toque em "Saber mais" para conversar sobre um deles 👇`;
      await addMessage(intro, 'bot', 'Catálogo');
      await addMessage(CATALOG_MARKER, 'bot', 'Catálogo');
      setIsTyping(false);
      inputRef.current?.focus();
      return;
    }

    try {
      const productsList = supabaseProducts.map(p => ({
        id: p.id,
        nome: p.name,
        preco: Number(p.price),
        descricao: p.short_description || p.long_description || '',
        precoMinimo: p.min_price_allowed,
        formasPagamento: p.payment_methods || [],
        infoEntrega: p.delivery_info || ''
      }));

      const productContext = contextProduct ? {
        id: contextProduct.id,
        nome: contextProduct.name,
        preco: contextProduct.price,
        descricao: contextProduct.long_description || contextProduct.short_description || '',
        categoria: contextProduct.category || '',
        precoMinimo: contextProduct.min_price_allowed,
        formasPagamento: contextProduct.payment_methods || [],
        infoEntrega: contextProduct.delivery_info || '',
        linkPagamento: contextProduct.payment_link || ''
      } : null;

      const recentHistory = messages.slice(-6).map(m => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.content
      }));

      const { data, error } = await supabase.functions.invoke('ai-fallback', {
        body: {
          message: trimmedInput,
          businessName: tenantConfig?.business_name || config?.business_name || business.nome || 'Loja',
          businessCategory: tenantConfig?.business_category || config?.business_category || business.categoria || 'varejo',
          products: productsList,
          productContext,
          productId: contextProduct?.id || null,
          negotiationState: negotiation,
          conversationHistory: recentHistory,
          lastBotResponse,
          closingState: closing,
          paymentLink: config?.payment_link,
          whatsappNumber: config?.whatsapp_number,
          saleMode: config?.sale_mode || 'vendedora',
          tenantId: storefront?.tenant_id || null,
          mode: contextProduct ? 'product' : 'vitrine'
        }
      });

      if (error) {
        await addMessage('Hmm, tive um problema. Pode repetir?', 'bot', 'Erro');
      } else {
        const response = data?.response || 'Como posso ajudar?';
        await addMessage(response, 'bot', data?.closingUpdate?.isClosing ? 'Fechamento' : 'IA');

        if (data?.showCatalog && supabaseProducts.length > 0) {
          await addMessage(CATALOG_MARKER, 'bot', 'Catálogo');
        }

        if (data?.negotiationUpdate) await updateNegotiation(data.negotiationUpdate);
        if (data?.closingUpdate) await updateClosing(data.closingUpdate);
      }

    } catch (err) {
      await addMessage('Desculpe, tive um problema. Pode repetir?', 'bot', 'Erro');
    } finally {
      setIsTyping(false);
      inputRef.current?.focus();
    }
  };

  if (loadingProducts || conversationLoading) {
    return (
      <div className="min-h-screen flex flex-col bg-background items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="mt-2 text-muted-foreground text-sm">Carregando...</p>
      </div>
    );
  }

  const storeName = tenantConfig?.business_name || config?.business_name || business.nome || 'Assistente';
  const vitrineLink = slug ? `/loja/${slug}` : '/vitrine';

  // Chat appearance from business_config
  const chatHeaderColor = config?.chat_header_color || undefined;
  const chatInputBg = config?.chat_input_bg_color || undefined;
  const chatSendColor = config?.chat_send_button_color || 'hsl(270 70% 60%)';
  const chatAniaBubble = config?.chat_ania_bubble_color || undefined;
  const chatUserBubble = config?.chat_user_bubble_color || '#005c4b';
  const chatIconColor = config?.chat_icon_color || undefined;
  const chatCatalogCard = config?.chat_catalog_card_color || undefined;
  const chatLinkColor = config?.chat_link_color || undefined;

  const wallpaperUrl = config?.chat_wallpaper_url || '';
  const wallpaperOpacity = (config?.chat_wallpaper_opacity ?? 100) / 100;
  const wallpaperBlurMap = { none: '0px', light: '3px', medium: '6px', strong: '12px' } as const;
  const wallpaperBlur = wallpaperBlurMap[(config?.chat_wallpaper_blur as keyof typeof wallpaperBlurMap) || 'none'];
  const wallpaperDim = config?.chat_wallpaper_dim ?? false;
  const wallpaperFit = config?.chat_wallpaper_fit || 'cover';
  const bgSize = wallpaperFit === 'contain' ? 'contain' : wallpaperFit === 'center' ? 'auto' : wallpaperFit === 'repeat' ? 'auto' : 'cover';
  const bgRepeat = wallpaperFit === 'repeat' ? 'repeat' : 'no-repeat';
  const bgPosition = 'center';

  return (
    <div
      className="min-h-screen flex flex-col relative"
      style={{ background: 'linear-gradient(180deg, hsl(var(--background)) 0%, hsl(230 30% 12%) 100%)', ['--chat-link' as any]: chatLinkColor }}
    >
      {wallpaperUrl && (
        <>
          <div
            className="fixed inset-0 pointer-events-none"
            style={{
              backgroundImage: `url(${wallpaperUrl})`,
              backgroundSize: bgSize,
              backgroundRepeat: bgRepeat,
              backgroundPosition: bgPosition,
              opacity: wallpaperOpacity,
              filter: wallpaperBlur !== '0px' ? `blur(${wallpaperBlur})` : undefined,
              zIndex: 0,
            }}
          />
          {wallpaperDim && (
            <div className="fixed inset-0 pointer-events-none bg-black/40" style={{ zIndex: 0 }} />
          )}
        </>
      )}
      <div className="relative z-[1] flex-1 flex flex-col min-h-screen">
      {/* Header - mantido igual, apenas ajuste de cor */}
      <header
        className="bg-card/95 backdrop-blur-md border-b border-border/30 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm"
        style={chatHeaderColor ? { backgroundColor: chatHeaderColor } : undefined}
      >
        {/* Botão voltar para vitrine */}
        <Link to={vitrineLink} className="p-2 hover:bg-muted/50 rounded-full transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        
        {contextProduct?.image_url ? (
          <img src={contextProduct.image_url} alt={contextProduct.name} className="w-10 h-10 rounded-full object-cover ring-2 ring-primary/20" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
            <MessageCircle className="w-5 h-5 text-primary" />
          </div>
        )}
        <div className="flex-1">
          <h1 className="font-semibold text-foreground">{contextProduct?.name || storeName}</h1>
          <p className="text-xs text-muted-foreground">{isTyping ? 'Digitando...' : 'Online'}</p>
        </div>
        
        {/* Botão limpar conversa */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClearConversation}
          disabled={isClearing || isTyping}
          className="hover:bg-destructive/10 hover:text-destructive transition-colors"
          title="Iniciar novo atendimento"
        >
          {isClearing ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Trash2 className="w-5 h-5" />
          )}
        </Button>

        {/* Botão áudio automático das respostas da ANIA */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleToggleAutoSpeak}
          className="hover:bg-muted/50 transition-colors"
          title={autoSpeakEnabled ? 'Áudio automático ativado' : 'Áudio automático desativado'}
          aria-label={autoSpeakEnabled ? 'Áudio automático ativado' : 'Áudio automático desativado'}
          aria-pressed={autoSpeakEnabled}
        >
          {autoSpeakEnabled ? (
            <Volume2 className="w-5 h-5" />
          ) : (
            <VolumeX className="w-5 h-5 text-muted-foreground" />
          )}
        </Button>

        {/* Link para ver produtos */}
        <Link to={vitrineLink} className="p-2 hover:bg-muted/50 rounded-full transition-colors">
          <ShoppingBag className="w-5 h-5 text-muted-foreground" />
        </Link>
      </header>

      {/* Chat area - estilo WhatsApp */}
      <main className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {/* Galeria de imagens do produto - exibida quando há galeria */}
        {contextProduct?.image_url && (contextProduct.has_gallery && galleryImages.length > 0) && (
          <div className="mb-4">
            <ProductGalleryPreview
              coverImage={contextProduct.image_url}
              galleryImages={galleryImages}
              productName={contextProduct.name}
              onOpenGallery={handleOpenGallery}
            />
          </div>
        )}

        {messages.map((message, index) => {
          const isCatalog = message.content === CATALOG_MARKER;

          if (isCatalog) {
            return (
              <div
                key={message.id}
                className="flex justify-start animate-slide-up"
                style={{ animationDelay: `${index * 20}ms` }}
              >
                <div
                  className="max-w-[92%] w-full text-foreground rounded-2xl rounded-tl-md border border-border/20 p-2.5 shadow-sm relative bg-card"
                  style={chatCatalogCard ? { backgroundColor: chatCatalogCard } : undefined}
                >
                  <div
                    className="absolute top-0 -left-1.5 w-3 h-3 border-l border-t border-border/20 bg-card"
                    style={chatCatalogCard ? { backgroundColor: chatCatalogCard, clipPath: 'polygon(100% 0, 100% 100%, 0 0)' } : { clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}
                  />
                  <div className="text-xs text-muted-foreground px-1 pb-1 font-medium">
                    🛍️ Catálogo
                  </div>
                  <CatalogCards
                    products={supabaseProducts.map(p => ({
                      id: p.id,
                      name: p.name,
                      price: Number(p.price),
                      image_url: p.image_url,
                      short_description: p.short_description,
                      payment_link: p.payment_link,
                      tenant_id: p.tenant_id,
                    }))}
                    slug={slug}
                  />
                  <span className="text-[10px] mt-1 block text-right text-muted-foreground">
                    {message.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            );
          }

          return (
            <div
              key={message.id}
              className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'} animate-slide-up`}
              style={{ animationDelay: `${index * 20}ms` }}
            >
              <div
                className={`max-w-[80%] relative px-3 py-2 shadow-sm ${
                  message.sender === 'user'
                    ? 'text-white rounded-2xl rounded-tr-md'
                    : 'text-foreground rounded-2xl rounded-tl-md border border-border/20'
                }`}
                style={
                  message.sender === 'user'
                    ? { backgroundColor: chatUserBubble }
                    : chatAniaBubble ? { backgroundColor: chatAniaBubble } : undefined
                }
              >
                <div
                  className={`absolute top-0 w-3 h-3 ${
                    message.sender === 'user' ? '-right-1.5' : '-left-1.5 border-l border-t border-border/20'
                  }`}
                  style={{
                    backgroundColor:
                      message.sender === 'user' ? chatUserBubble : (chatAniaBubble || undefined),
                    clipPath: message.sender === 'user'
                      ? 'polygon(0 0, 100% 0, 0 100%)'
                      : 'polygon(100% 0, 100% 100%, 0 0)',
                  }}
                />

                <div className="text-[15px] leading-relaxed [&_a]:text-[var(--chat-link,inherit)]">
                  <MarkdownMessage content={message.content} />
                </div>
                {message.sender === 'bot' && (
                  <SpeakButton
                    messageId={message.id}
                    text={message.content}
                    voice={config?.assistant_voice}
                    instructions={config?.assistant_voice_style}
                    speed={config?.assistant_voice_speed}
                  />
                )}


                <span className={`text-[10px] mt-1 block text-right ${
                  message.sender === 'user' ? 'text-white/70' : 'text-muted-foreground'
                }`}>
                  {message.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          );
        })}
        
        {/* Typing indicator */}
        {isTyping && (
          <div className="flex justify-start animate-slide-up">
            <div className="bg-card border border-border/20 rounded-2xl rounded-tl-md px-4 py-3 shadow-sm relative">
              <div 
                className="absolute top-0 -left-1.5 w-3 h-3 bg-card border-l border-t border-border/20"
                style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}
              />
              <div className="flex gap-1.5 items-center">
                <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce" />
                <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />

      </main>

      {/* Footer - input premium ANIA */}
      <footer
        className="px-3 pt-4 pb-4 safe-bottom sticky bottom-0 backdrop-blur-xl border-t border-white/5"
        style={{
          background: 'linear-gradient(180deg, hsl(230 40% 10% / 0.4) 0%, hsl(230 45% 8% / 0.95) 60%)',
          boxShadow: '0 -8px 32px -8px hsl(230 50% 3% / 0.6)',
        }}
      >
        {voice.status !== 'idle' && (
          <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2 px-4 py-2 rounded-full text-[13px] text-foreground/90 border border-white/10"
            style={{ background: 'hsl(230 40% 12% / 0.9)' }}
          >
            {voice.status === 'recording' ? (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                <span className="font-medium">Gravando {formatTimer(voice.seconds)}</span>
                <span className="text-muted-foreground text-[11px]">/ {formatTimer(voice.maxSeconds)}</span>
                <button
                  type="button"
                  onClick={voice.cancelRecording}
                  aria-label="Cancelar gravação"
                  title="Cancelar gravação"
                  className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-4 h-4" /> Cancelar
                </button>
              </>
            ) : (
              <>
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span className="font-medium">Transcrevendo...</span>
              </>
            )}
          </div>
        )}
        <div className="flex gap-2.5 max-w-3xl mx-auto items-center">
          <div
            className="relative flex-1 rounded-full p-[1.5px] transition-all duration-300"
            style={{
              background: 'linear-gradient(135deg, hsl(190 100% 50% / 0.6) 0%, hsl(270 70% 60% / 0.6) 100%)',
              boxShadow: '0 4px 24px -6px hsl(270 70% 60% / 0.35), inset 0 1px 0 hsl(0 0% 100% / 0.05)',
            }}
          >
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder={voice.status === 'recording' ? 'Gravando mensagem de voz...' : 'Digite sua mensagem para a ANIA...'}
              disabled={isTyping}
              className="flex-1 h-14 w-full rounded-full border-0 pl-5 pr-14 text-[15px] text-foreground placeholder:text-muted-foreground/80 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-0"
              style={{ backgroundColor: chatInputBg || 'hsl(230 40% 10% / 0.95)' }}
            />
            {voice.isSupported && (
              <button
                type="button"
                onClick={voice.status === 'recording' ? voice.stopRecording : voice.startRecording}
                disabled={isTyping || voice.status === 'transcribing'}
                aria-label={voice.status === 'recording' ? 'Parar gravação' : 'Gravar mensagem de voz'}
                title={voice.status === 'recording' ? 'Parar gravação' : 'Gravar mensagem de voz'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 active:scale-90 disabled:opacity-50"
                style={{
                  background: voice.status === 'recording' ? 'hsl(0 80% 55% / 0.2)' : 'transparent',
                  color: voice.status === 'recording' ? 'hsl(0 85% 65%)' : undefined,
                }}
              >
                {voice.status === 'transcribing' ? (
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                ) : voice.status === 'recording' ? (
                  <Square className="w-4 h-4 fill-current" />
                ) : (
                  <Mic className="w-5 h-5 text-muted-foreground" />
                )}
              </button>
            )}
          </div>
          <Button
            onClick={handleSend}
            disabled={!inputValue.trim() || isTyping}
            size="icon"
            className="w-14 h-14 rounded-full text-white shadow-lg transition-all duration-200 active:scale-90 hover:scale-105 disabled:opacity-50 disabled:hover:scale-100 border-0 shrink-0"
            style={{
              background: chatSendColor.includes('gradient')
                ? chatSendColor
                : `linear-gradient(135deg, ${chatSendColor} 0%, ${chatSendColor} 100%)`,
              boxShadow: `0 0 24px ${chatSendColor}80, 0 4px 16px ${chatSendColor}55, inset 0 1px 0 hsl(0 0% 100% / 0.2)`,
            }}
          >
            <Send className="w-6 h-6 -ml-0.5" />
          </Button>
        </div>
      </footer>

      {/* Modal da galeria de imagens */}
      {contextProduct?.image_url && (
        <ProductGalleryViewer
          coverImage={contextProduct.image_url}
          galleryImages={galleryImages}
          productName={contextProduct.name}
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
          initialIndex={galleryInitialIndex}
        />
      )}
      </div>
    </div>
  );
}
