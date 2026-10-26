package pizza.allan.frame;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FrameTransportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
