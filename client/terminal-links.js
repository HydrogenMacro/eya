// Terminal output is untrusted navigation input, including OSC 8 targets.
export function terminalLinkUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try { const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null; } catch { return null; }
}

export function terminalTextLinks(terminal, lineNumber, activate) {
  const buffer=terminal.buffer.active,index=lineNumber-1;
  if (index<0 || index>=buffer.length) return [];
  let start=index,end=index;
  while(start>0 && index-start<15 && buffer.getLine(start)?.isWrapped)start--;
  while(end+1<buffer.length && end-start<15 && buffer.getLine(end+1)?.isWrapped)end++;
  let text='',positions=[];
  for(let row=start;row<=end && text.length<8192;row++){
    const line=buffer.getLine(row);if(!line)break;
    for(let col=0;col<terminal.cols && text.length<8192;col++){
      const cell=line.getCell(col);if(cell?.getWidth()===0)continue;
      const value=cell?.getChars() || ' ';
      text+=value;for(let character=0;character<value.length;character++)positions.push({x:col+1,y:row+1});
    }
  }
  const links=[];
  for(const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)){
    let value=match[0].replace(/[.,;:!?]+$/,'');
    for(const [open,close] of [['(',')'],['[',']'],['{','}']])while(value.endsWith(close) && value.split(close).length>value.split(open).length)value=value.slice(0,-1);
    const url=terminalLinkUrl(value),first=positions[match.index],last=positions[match.index+value.length-1];
    if(!url || !first || !last || lineNumber<first.y || lineNumber>last.y)continue;
    links.push({text:value,range:{start:first,end:last},activate:event=>activate(event,url)});
  }
  return links;
}
