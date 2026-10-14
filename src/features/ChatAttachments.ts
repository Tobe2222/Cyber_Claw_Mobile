// Feature: Chat Attachments Enhancement Changes: 1.

import React from 'react';

interface AttachmentItem {
  id: string;
  uri: string;
  name: string;
  type: string;
  size?: number;
}

/** Usage in HomeScreen: const [attachments, setAttachments] = useState<AttachmentItem[]>([]); // Handle paste from clipboard const… */

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
