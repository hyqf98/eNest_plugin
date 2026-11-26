#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <WebKit/WebKit.h>
#import <unistd.h>

static void output(NSDictionary *object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}

@interface DeskWindow : NSWindow
@end
@implementation DeskWindow
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
- (NSRect)constrainFrameRect:(NSRect)frame toScreen:(NSScreen *)screen { return frame; }
@end

@interface Desktop : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate>
@property(strong) NSURL *assets;
@property(strong) NSURL *page;
@property(strong) NSMutableDictionary<NSString *,DeskWindow *> *windows;
@property(strong) NSMutableDictionary<NSString *,WKWebView *> *views;
@property(strong) NSMutableSet<NSString *> *ready;
@property(strong) NSArray *screens;
@property NSUInteger topology;
@property BOOL initialized;
@end

@implementation Desktop
- (void)fail:(NSString *)reason { output(@{@"event":@"error",@"reason":reason}); [NSApp terminate:nil]; }
- (void)clearWindows {
    for (WKWebView *view in self.views.allValues) { [view.configuration.userContentController removeScriptMessageHandlerForName:@"desktop"]; view.navigationDelegate=nil; [view stopLoading]; }
    for (DeskWindow *window in self.windows.allValues) [window close];
    self.windows=[NSMutableDictionary new]; self.views=[NSMutableDictionary new]; self.ready=[NSMutableSet new];
}
- (void)configure {
    [self clearWindows]; NSMutableArray *screens=[NSMutableArray new]; NSArray<NSScreen *> *all=NSScreen.screens;
    if (!all.count || all.count>16) { [self fail:@"无法识别当前显示器布局。"]; return; }
    NSInteger level=CGWindowLevelForKey(kCGDesktopIconWindowLevelKey)+1;
    if (level >= CGWindowLevelForKey(kCGNormalWindowLevelKey)) { [self fail:@"系统未提供桌面窗口层级。"]; return; }
    for (NSScreen *screen in all) {
        NSNumber *number=screen.deviceDescription[@"NSScreenNumber"]; if (!number) { [self fail:@"无法识别显示器。"];return; }
        CGDirectDisplayID display=number.unsignedIntValue; CFUUIDRef uuid=CGDisplayCreateUUIDFromDisplayID(display);
        if (!uuid) { [self fail:@"无法获取显示器标识。"]; return; }
        NSString *identifier=CFBridgingRelease(CFUUIDCreateString(NULL,uuid)); CFRelease(uuid);
        if (self.windows[identifier]) { [self fail:@"不支持不可区分的镜像显示器。"];return; }
        NSRect frame=screen.frame, work=NSIntersectionRect(frame,screen.visibleFrame);
        if (NSIsEmptyRect(frame)||NSIsEmptyRect(work)) { [self fail:@"显示器工作区不可用。"];return; }
        [screens addObject:@{@"id":identifier,@"label":screen.localizedName ?: @"显示器",@"primary":@(display==CGMainDisplayID()),@"insets":@{@"top":@(NSMaxY(frame)-NSMaxY(work)),@"bottom":@(NSMinY(work)-NSMinY(frame)),@"left":@(NSMinX(work)-NSMinX(frame)),@"right":@(NSMaxX(frame)-NSMaxX(work))}}];
        DeskWindow *window=[[DeskWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.level=level; window.releasedWhenClosed=NO; window.hasShadow=NO; window.opaque=YES; window.backgroundColor=[NSColor colorWithRed:.19 green:.35 blue:.36 alpha:1]; window.hidesOnDeactivate=NO; window.excludedFromWindowsMenu=YES; window.movable=NO;
        window.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorStationary|NSWindowCollectionBehaviorIgnoresCycle;
        [window setFrame:frame display:NO]; if(window.level!=level||!NSEqualRects(window.frame,frame)){[self fail:@"系统拒绝桌面窗口层级或工作区。"];return;}
        WKWebViewConfiguration *config=[WKWebViewConfiguration new];config.websiteDataStore=WKWebsiteDataStore.nonPersistentDataStore;config.preferences.javaScriptCanOpenWindowsAutomatically=NO;
        [config.userContentController addScriptMessageHandler:self name:@"desktop"];
        WKWebView *view=[[WKWebView alloc] initWithFrame:NSMakeRect(0,0,NSWidth(frame),NSHeight(frame)) configuration:config];view.navigationDelegate=self;view.UIDelegate=self;view.allowsBackForwardNavigationGestures=NO;
        window.contentView=view; self.windows[identifier]=window; self.views[identifier]=view;
        [view loadFileURL:self.page allowingReadAccessToURL:self.assets];
    }
    self.screens=screens;
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if(!message.frameInfo.mainFrame||![message.frameInfo.request.URL.URLByStandardizingPath isEqual:self.page]||![message.body isKindOfClass:NSString.class]||[message.body length]>20000)return;
    NSString *identifier=[self.views allKeysForObject:message.webView].firstObject;if(!identifier)return;
    NSDictionary *action=[NSJSONSerialization JSONObjectWithData:[message.body dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];if(![action isKindOfClass:NSDictionary.class])return;
    if([action[@"action"] isEqual:@"ready"]){[self.ready addObject:identifier];if(self.ready.count==self.views.count)output(@{@"event":@"attached",@"screens":self.screens});return;}
    output(@{@"event":@"action",@"screen":identifier,@"action":action});
}
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
    handler(action.targetFrame.mainFrame&&[action.request.URL.URLByStandardizingPath isEqual:self.page]?WKNavigationActionPolicyAllow:WKNavigationActionPolicyCancel);
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view { [self fail:@"桌面网页进程已结束，恢复系统桌面。"]; }
- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { if(error.code!=NSURLErrorCancelled)[self fail:@"无法载入本地桌面工作区。"]; }
- (void)receive:(NSDictionary *)object {
    if(![object isKindOfClass:NSDictionary.class])return;
    if([object[@"op"] isEqual:@"init"]){if(!self.initialized){self.initialized=YES;[self configure];}return;}
    if(![@[@"render",@"wallpaper",@"notice"] containsObject:object[@"op"]])return;
    NSData *json=[NSJSONSerialization dataWithJSONObject:object options:0 error:nil];NSString *value=[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];if(!value)return;
    NSString *script=[NSString stringWithFormat:@"window.enestDesktopReceive(%@)",value];
    for(NSString *key in self.views){if([object[@"screen"] length]&&![object[@"screen"] isEqual:key])continue;WKWebView *view=self.views[key];
        [view evaluateJavaScript:script completionHandler:^(id result,NSError *error){if(self.views[key]!=view)return;if(error){[self fail:@"桌面工作区不能响应，请在普通工作区继续。"];return;}if([object[@"op"] isEqual:@"render"]&&!self.windows[key].visible)[self.windows[key] orderFrontRegardless];}];
    }
}
- (void)applicationDidChangeScreenParameters:(NSNotification *)notification {
    if(!self.initialized)return;NSUInteger generation=++self.topology;dispatch_after(dispatch_time(DISPATCH_TIME_NOW,250*NSEC_PER_MSEC),dispatch_get_main_queue(),^{if(self.topology==generation)[self configure];});
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{@autoreleasepool{
        NSMutableData *pending=[NSMutableData data];char input[8192];ssize_t count;
        while((count=read(STDIN_FILENO,input,sizeof(input)))>0){
            const char *cursor=input,*limit=input+count;
            while(cursor<limit){
                const char *newline=memchr(cursor,'\n',limit-cursor),*stop=newline?:limit;
                [pending appendBytes:cursor length:stop-cursor];
                if(pending.length>5*1024*1024){dispatch_async(dispatch_get_main_queue(),^{[NSApp terminate:nil];});return;}
                if(!newline)break;
                @autoreleasepool{
                    NSDictionary *value=[NSJSONSerialization JSONObjectWithData:pending options:0 error:nil];[pending setLength:0];
                    if(![value isKindOfClass:NSDictionary.class]){dispatch_async(dispatch_get_main_queue(),^{[NSApp terminate:nil];});return;}
                    dispatch_sync(dispatch_get_main_queue(),^{[self receive:value];});
                }
                cursor=newline+1;
            }
        }
        dispatch_async(dispatch_get_main_queue(),^{[NSApp terminate:nil];});
    }});
}
@end

int main(int argc,char **argv){@autoreleasepool{
    if(argc!=2)return 2;[NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];__attribute__((objc_precise_lifetime)) Desktop *owner=[Desktop new];
    owner.assets=[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES].URLByStandardizingPath;
    owner.page=[owner.assets URLByAppendingPathComponent:@"native.html"].URLByStandardizingPath;NSApp.delegate=owner;[NSApp run];return 0;
}}
