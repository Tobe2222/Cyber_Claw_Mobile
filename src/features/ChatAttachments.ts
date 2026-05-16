// Feature: Chat Attachments Enhancement
// 
// Changes:
// 1. State for managing multiple attachments
// 2. Paste detection on text input (clipboard)
// 3. Attachment preview UI
// 4. Multi-attach send
// 5. Reduced text sizes

import React from 'react';

interface AttachmentItem {
  id: string;
  uri: string;
  name: string;
  type: string;
  size?: number;
}

/**
 * Usage in HomeScreen:
 * 
 * const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
 * 
 * // Handle paste from clipboard
 * const handlePasteImage = async () => {
 *   try {
 *     const clipboardImageUri = await Clipboard.getImageAsync();
 *     if (clipboardImageUri.startsWith('file://')) {
 *       const newAttachment: AttachmentItem = {
 *         id: Date.now().toString(),
 *         uri: clipboardImageUri,
 *         name: `pasted-${Date.now()}.png`,
 *         type: 'image/png',
 *       };
 *       setAttachments(prev => [...prev, newAttachment]);
 *     }
 *   } catch (e) {
 *     console.log('No image in clipboard');
 *   }
 * };
 * 
 * // Remove attachment
 * const removeAttachment = (id: string) => {
 *   setAttachments(prev => prev.filter(a => a.id !== id));
 * };
 * 
 * // Send with attachments
 * const sendWithAttachments = async () => {
 *   if (!inputText.trim() && attachments.length === 0) return;
 *   
 *   // Send text
 *   if (inputText.trim()) {
 *     syncClient.sendChat(inputText);
 *   }
 *   
 *   // Send attachments
 *   for (const attachment of attachments) {
 *     syncClient.sendAttachment(attachment.uri, attachment.type);
 *   }
 *   
 *   setInputText('');
 *   setAttachments([]);
 * };
 */

// CSS/StyleSheet changes for reduced text size:
export const chatTextSizeReductions = {
  chatBubbleText: {
    fontSize: 13,  // reduced from 14-15
    lineHeight: 18,
  },
  
  messageContainer: {
    maxWidth: '85%',
    marginVertical: 4,  // reduced from 6-8
  },
  
  timestampText: {
    fontSize: 10,  // reduced from 11-12
  },
};
