(function(window) {

  var VAD = function(options) {
    // Default options
    this.options = {
      fftSize: 512,
      bufferLen: 512, 
      voice_stop: function() {},
      voice_start: function() {},
      smoothingTimeConstant: 0.99, 
      energy_offset: 1e-8, // The initial offset.
      energy_threshold_ratio_pos: 2, // Signal must be twice the offset
      energy_threshold_ratio_neg: 0.5, // Signal must be half the offset
      energy_integration: 1, // Size of integration change compared to the signal per second.
      filter: [
        {f: 200, v:0}, // 0 -> 200 is 0
        {f: 2000, v:1} // 200 -> 2k is 1
      ],
      source: null,
      context: null
    };

    // User options
    for(var option in options) {
      if(options.hasOwnProperty(option)) {
        this.options[option] = options[option];
      }
    }

    // Require source
   if(!this.options.source)
     throw new Error("The options must specify a MediaStreamAudioSourceNode.");

    // Set this.options.context
    this.options.context = this.options.source.context;

    // Calculate time relationships
    this.hertzPerBin = this.options.context.sampleRate / this.options.fftSize;
    this.iterationFrequency = this.options.context.sampleRate / this.options.bufferLen;
    this.iterationPeriod = 1 / this.iterationFrequency;

    var DEBUG = true;
    if(DEBUG) console.log(
      'Vad' +
      ' | sampleRate: ' + this.options.context.sampleRate +
      ' | hertzPerBin: ' + this.hertzPerBin +
      ' | iterationFrequency: ' + this.iterationFrequency +
      ' | iterationPeriod: ' + this.iterationPeriod
    );

    this.setFilter = function(shape) {
      this.filter = [];
      for(var i = 0, iLen = this.options.fftSize / 2; i < iLen; i++) {
        this.filter[i] = 0;
        for(var j = 0, jLen = shape.length; j < jLen; j++) {
          if(i * this.hertzPerBin < shape[j].f) {
            this.filter[i] = shape[j].v;
            break; // Exit j loop
          }
        }
      }
    }

    this.setFilter(this.options.filter);

    // 計算したエネルギー値
    this.energy = 0;

    // エネルギー値を計算済みかどうか。計算済みなら、this.ready.energy == true。
    this.ready = {};
    
    // 音声アクティビティが検出中はtrue
    this.vadState = false;

    // Energy detector props
    this.energy_offset = this.options.energy_offset;
    this.energy_threshold_pos = this.energy_offset * this.options.energy_threshold_ratio_pos;
    this.energy_threshold_neg = this.energy_offset * this.options.energy_threshold_ratio_neg;

    this.voiceTrend = 0;
    this.voiceTrendMax = 10;
    this.voiceTrendMin = -10;
    this.voiceTrendStart = 5;
    this.voiceTrendEnd = -5;

    // AnalyserNodeクラス
    this.analyser = this.options.context.createAnalyser();

    // 周波数領域の波形(振幅スペクトル)描画に関連するプロパティ。時間的にスペクトルを平滑化させるのに用いられる。
    this.analyser.smoothingTimeConstant = this.options.smoothingTimeConstant; // 0.99;

    // 高速フーリエ変換を行う分割数の設定。必ず2の乗数
    this.analyser.fftSize = this.options.fftSize;

    // getFloatFrequencyDataで取得したデータの格納先。frequencyBinCountはfftSizeの1/2になる。
    this.floatFrequencyData = new Float32Array(this.analyser.frequencyBinCount);

    // Setup local storage of the Linear FFT data
    this.floatFrequencyDataLinear = new Float32Array(this.floatFrequencyData.length);

    // Connect this.analyser
    this.options.source.connect(this.analyser); 

    // Create ScriptProcessorNode
    this.scriptProcessorNode = this.options.context.createScriptProcessor(this.options.bufferLen, 1, 1);

    // Connect scriptProcessorNode (Theretically, not required)
    this.scriptProcessorNode.connect(this.options.context.destination);

    var self = this;
    // コールバック関数の設定
    this.scriptProcessorNode.onaudioprocess = function(event) {
      // データの取得
      self.analyser.getFloatFrequencyData(self.floatFrequencyData);
      self.update();
      self.monitor();
    };

    // Connect scriptProcessorNode
    this.options.source.connect(this.scriptProcessorNode);

    // log stuff
    this.logging = false;
    this.log_i = 0;
    this.log_limit = 100;

    this.triggerLog = function(limit) {
      this.logging = true;
      this.log_i = 0;
      this.log_limit = typeof limit === 'number' ? limit : this.log_limit;
    }

    // Log関数
    this.log = function(msg) {
      if(this.logging && this.log_i < this.log_limit) {
        this.log_i++;
        console.log(msg);
      } else {
        this.logging = false;
      }
    }

    // 更新関数
    this.update = function() {
      // Update the local version of the Linear FFT
      
      // fftは直近に取得したデータ
      var fft = this.floatFrequencyData;

      for(var i = 0, iLen = fft.length; i < iLen; i++) {
        // Math.pow(底,指数) …… 指定された底と指数の累乗を返す
        this.floatFrequencyDataLinear[i] = Math.pow(10, fft[i] / 10);
      }

      this.ready = {};
    }

    // エネルギー取得関数
    this.getEnergy = function() {
      if(this.ready.energy) {
        return this.energy;
      }

      var energy = 0;
      var fft = this.floatFrequencyDataLinear;

      for(var i = 0, iLen = fft.length; i < iLen; i++) {
        energy += this.filter[i] * fft[i] * fft[i];
      }

      this.energy = energy;
      this.ready.energy = true;

      return energy;
    }

    // モニター関数
    this.monitor = function() {
      var energy = this.getEnergy();
      var signal = energy - this.energy_offset;

      if(signal > this.energy_threshold_pos) {
        this.voiceTrend++;
        if(this.voiceTrend > this.voiceTrendMax) {
          this.voiceTrend = this.voiceTrendMax;
        }
      } else if(signal < -this.energy_threshold_neg) {
        this.voiceTrend--;
        if(this.voiceTrend < this.voiceTrendMin) {
          this.voiceTrend = this.voiceTrendMin;
        }
      } else {
        // トレンドを0に近づける
        if(this.voiceTrend > 0) {
          this.voiceTrend--;
        } else if(this.voiceTrend < 0) {
          this.voiceTrend++;
        }
      }

      // 発話検出
      var start = false;
      // 終話検出
      var end = false;

      if(this.voiceTrend > this.voiceTrendStart) {
        start = true;
      } else if(this.voiceTrend < this.voiceTrendEnd) {
        end = true;
      }

      // Integration brings in the real-time aspect through the relationship with the frequency this functions is called.
      var integration = signal * this.iterationPeriod * this.options.energy_integration;

      // Idea?: The integration is affected by the voiceTrend magnitude? - Not sure. Not doing atm.

      // The !end limits the offset delta boost till after the end is detected.
      if(integration > 0 || !end) {
        this.energy_offset += integration;
      } else {
        this.energy_offset += integration * 10;
      }
      this.energy_offset = this.energy_offset < 0 ? 0 : this.energy_offset;
      this.energy_threshold_pos = this.energy_offset * this.options.energy_threshold_ratio_pos;
      this.energy_threshold_neg = this.energy_offset * this.options.energy_threshold_ratio_neg;

      // Broadcast the messages
      if(start && !this.vadState) {
        this.vadState = true;
        this.options.voice_start();
      }
      if(end && this.vadState) {
        this.vadState = false;
        this.options.voice_stop();
      }

      this.log(
        'e: ' + energy +
        ' | e_of: ' + this.energy_offset +
        ' | e+_th: ' + this.energy_threshold_pos +
        ' | e-_th: ' + this.energy_threshold_neg +
        ' | signal: ' + signal +
        ' | int: ' + integration +
        ' | voiceTrend: ' + this.voiceTrend +
        ' | start: ' + start +
        ' | end: ' + end
      );

      return signal;
    }
  };

  window.VAD = VAD;

})(window);
